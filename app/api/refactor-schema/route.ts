/**
 * Schema Refactoring API Endpoint
 *
 * PURPOSE:
 * This endpoint automatically refactors database tables to fix structural issues.
 * After the analyze-schema endpoint identifies problems, this endpoint can
 * automatically fix them by splitting wide tables or consolidating similar ones.
 *
 * WHAT IT DOES:
 * 1. Receives information about the issue to fix
 * 2. Extracts the affected table(s) from the schema
 * 3. Uses Claude AI to redesign the tables following best practices
 * 4. Returns the refactored schema that replaces the problematic tables
 *
 * REFACTORING TYPES:
 * - Table Splitting: Takes a table with 20+ fields and splits it into 2-4 smaller,
 *   focused tables (e.g., user -> user + user_preferences + user_address)
 * - Consolidation: Takes multiple similar tables and merges them into one with a
 *   "type" field to distinguish records (e.g., admin_notification + user_notification -> notification)
 *
 * WHY THIS MATTERS:
 * Manually refactoring database tables is tedious and error-prone. This automates
 * the process, ensuring proper foreign key relationships are maintained and
 * that the refactored schema follows Bubble.io best practices.
 *
 * INPUT:
 * - issue: The schema issue to fix (from analyze-schema)
 * - tableDbml/currentDbml: The affected table(s) to refactor
 *
 * OUTPUT:
 * - refactoredDbml: The new table definitions to replace the old ones
 * - originalTableName(s): What was refactored
 * - newTableNames: What new tables were created
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Builds the Prompt for Splitting Wide Tables
 *
 * When a table has too many fields (e.g., 20+ columns), it slows down all queries
 * because Bubble loads all fields even when only a few are needed.
 *
 * This prompt instructs Claude to:
 * 1. Group related fields together (addresses, preferences, etc.)
 * 2. Create new tables for each group
 * 3. Keep core identifying fields in the original table
 * 4. Link the new tables back to the original with foreign keys
 */
function buildSplitPrompt(
  tableDbml: string,
  tableName: string,
  existingTableNames: string[],
  issueCategory: string
): string {
  const categoryGuidance: { [key: string]: string } = {
    "table-width": `GOAL: Split this wide table into 2-4 smaller, focused tables.

STRATEGY:
1. Group related fields (address fields, contact fields, preferences, etc.)
2. Create new tables for each group
3. Keep only core identifying fields in the original table
4. Each new table links back to the original via foreign key`,

    "relationship-depth": `GOAL: Flatten deep relationship chains by adding direct references.`,

    "missing-back-reference": `GOAL: Add missing back-references for efficient reverse lookups.`,

    "data-duplication": `GOAL: Normalize duplicated data into a single source of truth.`,
  };

  const guidance = categoryGuidance[issueCategory] || categoryGuidance["table-width"];

  return `You are refactoring a single Bubble.io database table to fix performance issues.

TABLE TO REFACTOR:
${tableDbml}

${guidance}

EXISTING TABLES IN THE SCHEMA (do not create tables with these names):
${existingTableNames.join(", ")}

BUBBLE.IO TYPE RULES:
- Primary keys: _id unique
- Foreign keys: {table_name}_id {table_name} [ref: > {table_name}._id]
- Types: text, number, Y_N, date, unique

CRITICAL RULES:
1. REMOVE fields from "${tableName}" when you move them - NO duplicates
2. Use INLINE refs: user_id user [ref: > user._id]
3. NO standalone "Ref:" statements
4. NO TableGroup definitions
5. Return ONLY the Table definitions - nothing else

EXAMPLE OUTPUT FORMAT:
Table ${tableName} {
  _id unique
  name text
  email text
  Note: 'Core fields only - other data split to separate tables'
}

Table ${tableName}_address {
  _id unique
  ${tableName}_id ${tableName} [ref: > ${tableName}._id]
  address1 text
  city text
  Note: 'Address data split from ${tableName}'
}

Table ${tableName}_preferences {
  _id unique
  ${tableName}_id ${tableName} [ref: > ${tableName}._id]
  preferences text
  Note: 'Preferences split from ${tableName}'
}

OUTPUT: Return ONLY the refactored Table definitions. No markdown, no explanations.`;
}

// Builds prompt for consolidating multiple similar tables into one
function buildConsolidationPrompt(
  tablesDbml: string,
  tableNames: string[],
  existingTableNames: string[],
  suggestedName: string
): string {
  return `You are consolidating multiple similar Bubble.io database tables into a single unified table.

TABLES TO CONSOLIDATE:
${tablesDbml}

GOAL: Merge these ${tableNames.length} similar tables into ONE unified table with a "type" field to distinguish records.

STRATEGY:
1. Create a single new table named "${suggestedName}" (or similar descriptive name)
2. Add a "type" field (text) to identify which original table each record came from
3. Include ALL unique fields from all the original tables
4. Fields that exist in multiple tables should appear once in the consolidated table
5. The original tables will be DELETED - do NOT include them in output

EXISTING TABLES IN THE SCHEMA (do not use these names for the new table):
${existingTableNames.filter(n => !tableNames.includes(n)).join(", ")}

BUBBLE.IO TYPE RULES:
- Primary keys: _id unique
- Foreign keys: {table_name}_id {table_name} [ref: > {table_name}._id]
- Types: text, number, Y_N, date, unique

CRITICAL RULES:
1. Return ONLY ONE consolidated table - do NOT return the original tables
2. Add a "type" field to distinguish record types (e.g., type text - values would be "${tableNames.join('", "')}")
3. Use INLINE refs: user_id user [ref: > user._id]
4. NO standalone "Ref:" statements
5. NO TableGroup definitions
6. Return ONLY the Table definition - nothing else

EXAMPLE - If consolidating "admin_notification" and "user_notification" tables:

Table notification {
  _id unique
  Created_Date date
  Modified_Date date
  type text
  title text
  message text
  read Y_N
  user_id user [ref: > user._id]
  Note: 'Consolidated from admin_notification and user_notification. Use type field to filter.'
}

OUTPUT: Return ONLY the consolidated Table definition. No markdown, no explanations.`;
}

function validateDbml(dbml: string): { valid: boolean; error?: string } {
  if (!dbml.includes("Table ")) {
    return { valid: false, error: "No tables defined" };
  }

  const openBraces = (dbml.match(/\{/g) || []).length;
  const closeBraces = (dbml.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    return { valid: false, error: "Mismatched braces" };
  }

  return { valid: true };
}

// Helper to extract a single table from full DBML
function extractTableFromDbml(fullDbml: string, tableName: string): string | null {
  const lines = fullDbml.split('\n');
  let inTargetTable = false;
  let braceCount = 0;
  const tableLines: string[] = [];

  for (const line of lines) {
    const tableMatch = line.match(/^Table\s+(?:"([^"]+)"|(\w+))\s*\{?/);
    if (tableMatch) {
      const matchedName = tableMatch[1] || tableMatch[2];
      if (matchedName === tableName) {
        inTargetTable = true;
        braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        tableLines.push(line);
        continue;
      }
    }

    if (inTargetTable) {
      tableLines.push(line);
      braceCount += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (braceCount <= 0) break;
    }
  }

  return tableLines.length > 0 ? tableLines.join('\n') : null;
}

// Helper to get all table names from DBML
function getTableNames(dbml: string): string[] {
  const names: string[] = [];
  const regex = /Table\s+(?:"([^"]+)"|(\w+))\s*\{/g;
  let match;
  while ((match = regex.exec(dbml)) !== null) {
    names.push(match[1] || match[2]);
  }
  return names;
}

// Helper to find common suffix in table names for consolidation
// e.g., ["admin_notification", "user_notification"] -> "notification"
function findCommonSuffix(tableNames: string[]): string | null {
  if (tableNames.length < 2) return null;

  // Split each table name by underscore and find common ending parts
  const splitNames = tableNames.map(name => name.split('_'));

  // Start from the end and find common parts
  const firstParts = splitNames[0];
  let commonParts: string[] = [];

  for (let i = 1; i <= firstParts.length; i++) {
    const suffix = firstParts.slice(-i);
    const suffixStr = suffix.join('_');

    const allMatch = splitNames.every(parts => {
      const partsSuffix = parts.slice(-i).join('_');
      return partsSuffix === suffixStr;
    });

    if (allMatch) {
      commonParts = suffix;
    } else {
      break;
    }
  }

  return commonParts.length > 0 ? commonParts.join('_') : null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const issue = body.issue;

    if (!issue || !issue.title) {
      return NextResponse.json(
        { error: "Issue details are required" },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key not configured" },
        { status: 500 }
      );
    }

    const anthropic = new Anthropic({ apiKey });

    // Check if this is a consolidation request (needs multiple tables)
    const isConsolidation = issue.category === "consolidation-opportunity";

    let tableDbml: string;
    let tableName: string;
    let tableNames: string[] = []; // For consolidation - all tables being merged
    let existingTableNames: string[];
    let fullDbml: string | null = null;

    if (body.tableDbml && body.tableName) {
      // NEW optimized format - client sends just the affected table(s)
      tableDbml = body.tableDbml;
      tableName = body.tableName;
      existingTableNames = body.existingTableNames || [];
      tableNames = body.tableNames || [tableName]; // For consolidation
      console.log("Using NEW optimized format");
    } else if (body.currentDbml && issue?.affectedTables?.[0]) {
      // OLD format - extract table(s) from full schema (backwards compatible)
      // First, strip all standalone Ref statements from the input - we only want inline refs
      const cleanedDbml = body.currentDbml.replace(/\n+Ref:\s*[^\n]+/g, '').trim();
      fullDbml = cleanedDbml;
      existingTableNames = getTableNames(cleanedDbml);

      if (isConsolidation && issue.affectedTables.length > 1) {
        // For consolidation, extract ALL affected tables
        tableNames = issue.affectedTables;
        tableName = tableNames[0]; // Primary table name for reference
        const extractedTables: string[] = [];

        for (const tName of tableNames) {
          const extracted = extractTableFromDbml(cleanedDbml, tName);
          if (extracted) {
            extractedTables.push(extracted);
          } else {
            console.log(`Warning: Could not find table "${tName}" for consolidation`);
          }
        }

        if (extractedTables.length < 2) {
          return NextResponse.json(
            { error: "Consolidation requires at least 2 tables to be found" },
            { status: 400 }
          );
        }

        tableDbml = extractedTables.join('\n\n');
        console.log(`Using OLD format (consolidation) - extracted ${extractedTables.length} tables (${tableDbml.length} chars)`);
      } else {
        // Standard refactoring - extract single table
        tableName = issue.affectedTables[0];
        tableNames = [tableName];

        const extracted = extractTableFromDbml(cleanedDbml, tableName);
        if (!extracted) {
          return NextResponse.json(
            { error: `Could not find table "${tableName}" in schema` },
            { status: 400 }
          );
        }
        tableDbml = extracted;
        console.log(`Using OLD format - extracted "${tableName}" (${tableDbml.length} chars) from full schema (${cleanedDbml.length} chars)`);
      }
    } else {
      return NextResponse.json(
        { error: "Invalid request format. Provide either {tableDbml, tableName} or {currentDbml, issue}" },
        { status: 400 }
      );
    }

    console.log(`Refactoring: category="${issue.category}", tables=${tableNames.join(", ")}`);
    console.log(`Existing tables: ${existingTableNames?.length || 0}`);

    // Build appropriate prompt and instruction based on issue category
    let systemPrompt: string;
    let instruction: string;

    if (isConsolidation) {
      // Generate a suggested consolidated table name from the affected tables
      // e.g., "admin_notification" + "user_notification" -> "notification"
      const commonSuffix = findCommonSuffix(tableNames);
      const suggestedName = commonSuffix || `consolidated_${tableNames[0]}`;

      systemPrompt = buildConsolidationPrompt(
        tableDbml,
        tableNames,
        existingTableNames || [],
        suggestedName
      );

      instruction = `Consolidate these ${tableNames.length} tables into ONE unified table: ${issue.title}

Tables to merge: ${tableNames.join(", ")}

Problem: ${issue.description}
Recommendation: ${issue.recommendation}

Create a single table with a "type" field to distinguish records. Include all unique fields from all tables.`;
    } else {
      // Standard split/refactor
      systemPrompt = buildSplitPrompt(
        tableDbml,
        tableName,
        existingTableNames || [],
        issue.category || "table-width"
      );

      instruction = `Refactor the "${tableName}" table to fix: ${issue.title}

Problem: ${issue.description}
Recommendation: ${issue.recommendation}

Split "${tableName}" into 2-4 smaller tables. Remove moved fields from the original. Add inline refs in new tables.`;
    }

    const message = await anthropic.messages.create({
      model: "claude-opus-4-20250514",
      max_tokens: 4096,
      temperature: 0.2,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: instruction,
        },
      ],
    });

    let refactoredDbml =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!refactoredDbml) {
      return NextResponse.json(
        { error: "No response from AI" },
        { status: 500 }
      );
    }

    // Clean up markdown code blocks if present
    refactoredDbml = refactoredDbml.trim();
    if (refactoredDbml.startsWith("```")) {
      refactoredDbml = refactoredDbml
        .replace(/^```(?:dbml)?\s*\n?/, "")
        .replace(/\n?```\s*$/, "");
    }
    refactoredDbml = refactoredDbml.trim();

    // Remove any TableGroup definitions
    refactoredDbml = refactoredDbml.replace(/\n*TableGroup\s+"[^"]*"\s*\[?[^\]]*\]?\s*\{[^}]*\}/g, '');

    // Remove any standalone Ref statements
    refactoredDbml = refactoredDbml.replace(/\n+Ref:\s*[^\n]+/g, '');
    refactoredDbml = refactoredDbml.trim();

    console.log("Refactored output (first 500 chars):", refactoredDbml.substring(0, 500));

    // Validate the output
    const validation = validateDbml(refactoredDbml);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Invalid DBML generated: ${validation.error}` },
        { status: 400 }
      );
    }

    // Extract the new table names from the output
    // For consolidation, ALL output tables are "new" (the original tables are being removed)
    // For splitting, tables that aren't the original are "new"
    const newTableNames: string[] = [];
    const tableRegex = /Table\s+(\w+)\s*\{/g;
    let match;
    while ((match = tableRegex.exec(refactoredDbml)) !== null) {
      if (isConsolidation) {
        // For consolidation, all tables in output are new (originals are removed)
        newTableNames.push(match[1]);
      } else {
        // For splitting, only tables that aren't the original are new
        if (match[1] !== tableName) {
          newTableNames.push(match[1]);
        }
      }
    }

    // If OLD format was used, merge refactored tables back into full schema
    let finalDbml = refactoredDbml;
    if (fullDbml) {
      // For consolidation: remove ALL affected tables
      // For splitting: remove only the primary table
      const tablesToRemove = isConsolidation ? tableNames : [tableName];

      const fullLines = fullDbml.split('\n');
      const mergedLines: string[] = [];
      let inTableToRemove = false;
      let braceCount = 0;

      for (const line of fullLines) {
        const tableMatch = line.match(/^Table\s+(?:"([^"]+)"|(\w+))\s*\{?/);
        if (tableMatch) {
          const matchedName = tableMatch[1] || tableMatch[2];
          if (tablesToRemove.includes(matchedName)) {
            inTableToRemove = true;
            braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
            continue;
          }
        }

        if (inTableToRemove) {
          braceCount += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
          if (braceCount <= 0) {
            inTableToRemove = false;
          }
          continue;
        }

        mergedLines.push(line);
      }

      // Find where to insert (before Ref statements)
      let insertIndex = mergedLines.length;
      for (let i = 0; i < mergedLines.length; i++) {
        if (mergedLines[i].startsWith('Ref:')) {
          insertIndex = i;
          break;
        }
      }

      mergedLines.splice(insertIndex, 0, '', refactoredDbml);
      finalDbml = mergedLines.join('\n');
      console.log(`Merged refactored tables back into full schema (${finalDbml.length} chars)`);
      if (isConsolidation) {
        console.log(`Consolidation: removed ${tablesToRemove.length} original tables, added ${newTableNames.length} consolidated table(s)`);
      }
    }

    // Remove ALL standalone Ref statements from final output - refs should only be inline
    finalDbml = finalDbml.replace(/\n+Ref:\s*[^\n]+/g, '');
    finalDbml = finalDbml.trim();

    return NextResponse.json({
      refactoredDbml: finalDbml,
      originalTableName: tableName,
      originalTableNames: tableNames, // For consolidation, this includes ALL merged tables
      newTableNames,
      issueFixed: issue.title,
      isConsolidation,
    });
  } catch (error) {
    console.error("Error in refactor-schema route:", error);

    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        return NextResponse.json(
          { error: "Too many requests. Please try again in a moment." },
          { status: 429 }
        );
      }
      if (error.status === 401) {
        return NextResponse.json(
          { error: "API configuration error" },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to refactor schema" },
      { status: 500 }
    );
  }
}
