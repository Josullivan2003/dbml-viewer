/**
 * Table Finder API Endpoint
 *
 * PURPOSE:
 * This endpoint helps users understand which tables in their database are
 * involved in a specific feature or workflow. Users can ask questions like
 * "What tables handle user authentication?" or "Which tables are used for
 * the checkout process?" and get a visual grouping of relevant tables.
 *
 * WHAT IT DOES:
 * 1. Receives a question about the database (e.g., "What handles payments?")
 * 2. Sends the question to Claude AI along with a simplified view of the schema
 * 3. Claude identifies which tables are relevant and explains each one's role
 * 4. Returns a TableGroup definition that highlights these tables in the diagram
 *
 * WHY THIS MATTERS:
 * Large databases can have dozens of tables, making it hard to understand
 * how they fit together. This feature lets users ask questions in plain
 * English and see which tables are relevant, with explanations of each table's
 * role in the feature they're asking about.
 *
 * INPUT:
 * - dbml: The database schema to analyze
 * - question: Plain English question about which tables are involved in something
 *
 * OUTPUT:
 * - updatedDbml: Schema with a TableGroup added to highlight relevant tables
 * - matchedTables: List of table names that are relevant
 * - tableExplanations: For each table, an explanation of its role
 * - explanation: Overall summary of why these tables are grouped
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Simplifies DBML for the AI Prompt
 *
 * Full DBML schemas can be very large with many field definitions.
 * For table identification, Claude only needs to see the table names
 * and their descriptions (Note: lines).
 *
 * This function strips out field definitions to reduce token usage
 * while keeping enough context for accurate table identification.
 */
function simplifyDbmlForPrompt(dbml: string): string {
  const lines = dbml.split('\n');
  const simplified: string[] = [];
  let inTable = false;

  for (const line of lines) {
    // Keep table definitions
    if (line.match(/^Table\s+/)) {
      simplified.push(line);
      inTable = true;
      continue;
    }
    // End of table
    if (line.trim() === '}' && inTable) {
      simplified.push(line);
      inTable = false;
      continue;
    }
    // Keep Note comments inside tables (they document purpose)
    if (inTable && line.includes('Note:')) {
      simplified.push(line);
    }
  }

  return simplified.join('\n');
}

// Builds the system prompt for table identification and grouping
// This prompt tells Claude to analyze the user's question, identify relevant tables,
// and add a TableGroup definition to the DBML with per-table explanations
function buildSystemPrompt(dbml: string): string {
  const simplifiedDbml = simplifyDbmlForPrompt(dbml);

  return `You are a database schema expert analyzing a Bubble.io database schema in DBML format.

AVAILABLE TABLES:
${simplifiedDbml}

YOUR TASK:
1. The user will ask a question about which tables are involved in a specific feature or workflow
2. Identify ALL tables from the schema that are relevant to answering their question
3. Generate a TableGroup definition that groups these related tables together
4. For each table, provide a brief inline comment explaining why it's included in the group

IMPORTANT RULES:
1. Return ONLY the TableGroup block - no markdown code blocks, no explanations, no extra text
2. Do NOT add any new tables or fields
3. Ensure ALL braces are balanced
4. Each table MUST have an inline comment (using //) explaining its role in the feature/workflow
5. The TableGroup must include a Note explaining why these tables are grouped together

TABLEGROUP SYNTAX:
TableGroup "descriptive_name" [color: #FFBD94] {
  table1 // Brief explanation of table1's role
  table2 // Brief explanation of table2's role
  table3 // Brief explanation of table3's role
  Note: '''Overall explanation of the feature or workflow this group represents'''
}

EXAMPLE:
If user asks "What tables handle user authentication?", and you identify user, session, and login_attempt tables:
TableGroup "user_authentication" [color: #FFBD94] {
  user // Contains user account information and login credentials
  session // Tracks active user sessions and maintains login state
  login_attempt // Logs authentication attempts for security and fraud detection
  Note: '''Tables involved in user authentication workflow'''
}

Return ONLY the TableGroup block shown above. Nothing else.`;
}

// Validates basic DBML structure - checks for tables and balanced braces
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

// Extracts table names mentioned in the schema to validate which tables exist
function extractTableNames(dbml: string): string[] {
  const tableRegex = /Table\s+(?:"([^"]+)"|(\w+))\s*\{/g;
  const tables: string[] = [];
  let match;

  while ((match = tableRegex.exec(dbml)) !== null) {
    const tableName = match[1] || match[2];
    tables.push(tableName);
  }

  return tables;
}

// Extracts the TableGroup definition and its properties from the DBML
// Returns the group name and list of tables included in the group
function extractTableGroupInfo(
  dbml: string
): { groupName: string; tables: string[]; explanation: string } | null {
  // Find the last TableGroup in the DBML
  const tableGroupRegex =
    /TableGroup\s+"([^"]+)"\s*(?:\[color:\s*[#\w]+\])?\s*\{([^}]+)\}/;
  const match = dbml.match(tableGroupRegex);

  if (!match) {
    return null;
  }

  const groupName = match[1];
  const groupContent = match[2];

  // Extract table names from group content (lines before Note:)
  // Each line may have an inline comment: tablename // explanation
  // We need to extract just the table name part before any comment
  const tablesSection = groupContent.split("Note:")[0];
  const tables = tablesSection
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // If line has inline comment (//), extract just the part before it
      const beforeComment = trimmed.split("//")[0].trim();
      return beforeComment;
    })
    .filter((line) => line && !line.startsWith("//"));

  // Extract the explanation from Note:
  const noteMatch = groupContent.match(/Note:\s*'''([^']+)'''/);
  const explanation = noteMatch ? noteMatch[1].trim() : "";

  return { groupName, tables, explanation };
}

// Extracts per-table explanations from inline comments in the TableGroup
// Parses comments in format: tablename // explanation
function extractTableExplanations(
  dbml: string
): { table: string; explanation: string }[] {
  const tableGroupRegex =
    /TableGroup\s+"[^"]+"\s*(?:\[color:\s*[#\w]+\])?\s*\{([^}]+)\}/;
  const match = dbml.match(tableGroupRegex);

  if (!match) {
    return [];
  }

  const groupContent = match[1];
  const tableExplanations: { table: string; explanation: string }[] = [];

  // Process each line in the TableGroup
  const lines = groupContent.split("\n");
  for (const line of lines) {
    // Skip Note: lines and empty lines
    if (line.includes("Note:") || !line.trim()) {
      continue;
    }

    // Match pattern: tablename // explanation
    // This regex captures the table name and everything after //
    const tableMatch = line.match(/^\s*(\w+)\s*\/\/\s*(.+)$/);
    if (tableMatch) {
      tableExplanations.push({
        table: tableMatch[1].trim(),
        explanation: tableMatch[2].trim(),
      });
    }
  }

  return tableExplanations;
}

export async function POST(request: NextRequest) {
  try {
    const { dbml, question } = await request.json();

    // Validate required inputs
    if (!dbml) {
      return NextResponse.json(
        { error: "DBML schema is required" },
        { status: 400 }
      );
    }

    if (!question || question.trim().length < 5) {
      return NextResponse.json(
        { error: "Question must be at least 5 characters" },
        { status: 400 }
      );
    }

    if (question.length > 500) {
      return NextResponse.json(
        { error: "Question must be less than 500 characters" },
        { status: 400 }
      );
    }

    // Validate input DBML has tables
    const validation = validateDbml(dbml);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Invalid input DBML: ${validation.error}` },
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

    // Call Claude API to identify tables and generate TableGroup
    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      temperature: 0.3,
      system: buildSystemPrompt(dbml),
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    });

    // Extract response text (Claude returns ONLY the TableGroup block)
    let tableGroupBlock =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!tableGroupBlock) {
      return NextResponse.json(
        { error: "No response from AI" },
        { status: 500 }
      );
    }

    // Clean up markdown if present
    tableGroupBlock = tableGroupBlock.trim();
    if (tableGroupBlock.startsWith("```")) {
      tableGroupBlock = tableGroupBlock
        .replace(/^```(?:dbml)?\n?/, "")
        .replace(/\n?```$/, "");
    }
    tableGroupBlock = tableGroupBlock.trim();

    // Append the TableGroup to the original DBML to create the complete updated schema
    const updatedDbml = dbml.trimEnd() + "\n\n" + tableGroupBlock;

    // Validate the combined DBML
    const outputValidation = validateDbml(updatedDbml);
    if (!outputValidation.valid) {
      return NextResponse.json(
        { error: `Invalid DBML generated: ${outputValidation.error}` },
        { status: 400 }
      );
    }

    // Extract TableGroup information from the combined DBML
    const tableGroupInfo = extractTableGroupInfo(updatedDbml);
    if (!tableGroupInfo) {
      return NextResponse.json(
        { error: "Failed to extract table group from response" },
        { status: 400 }
      );
    }

    // Filter out any tables that don't actually exist in the schema
    // The AI sometimes hallucinates table names that aren't in the original DBML
    const schemaTableNames = extractTableNames(dbml);
    const originalTableCount = tableGroupInfo.tables.length;
    const validTables = tableGroupInfo.tables.filter((table) =>
      schemaTableNames.includes(table)
    );

    // If no valid tables remain after filtering, return an error
    if (validTables.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not find any matching tables for your question. Please try rephrasing.",
        },
        { status: 400 }
      );
    }

    // Check if we need to rebuild the TableGroup (some tables were filtered out)
    const needsRebuild = validTables.length < originalTableCount;
    let finalDbml = updatedDbml;

    if (needsRebuild) {
      // Get only the valid table explanations from the original AI response
      const validTableExplanationsMap = new Map<string, string>();
      const allExplanations = extractTableExplanations(updatedDbml);
      for (const exp of allExplanations) {
        if (validTables.includes(exp.table)) {
          validTableExplanationsMap.set(exp.table, exp.explanation);
        }
      }

      // Rebuild the TableGroup with only valid tables
      const rebuiltTableLines = validTables
        .map((table) => {
          const explanation =
            validTableExplanationsMap.get(table) ||
            `Part of ${tableGroupInfo.groupName.replace(/_/g, " ")}`;
          return `  ${table} // ${explanation}`;
        })
        .join("\n");

      const rebuiltTableGroup = `TableGroup "${tableGroupInfo.groupName}" [color: #FFBD94] {
${rebuiltTableLines}
  Note: '''${tableGroupInfo.explanation}'''
}`;

      finalDbml = dbml.trimEnd() + "\n\n" + rebuiltTableGroup;
    }

    // Update tableGroupInfo with only valid tables
    tableGroupInfo.tables = validTables;

    // Extract per-table explanations from inline comments (use finalDbml for accurate data)
    let tableExplanations = extractTableExplanations(finalDbml);

    // If no explanations were found, generate fallback generic explanations from table names
    if (tableExplanations.length === 0 && validTables.length > 0) {
      tableExplanations = validTables.map((table) => ({
        table,
        explanation: `Part of ${tableGroupInfo.groupName.replace(/_/g, " ")}`,
      }));
    }

    // Filter explanations to only include valid tables
    tableExplanations = tableExplanations.filter((exp) =>
      validTables.includes(exp.table)
    );

    // Return success response with updated DBML and group details
    return NextResponse.json({
      updatedDbml: finalDbml,
      tableGroupName: tableGroupInfo.groupName,
      matchedTables: validTables,
      explanation: tableGroupInfo.explanation,
      tableExplanations,
    });
  } catch (error) {
    console.error("Error in table-finder route:", error);

    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        return NextResponse.json(
          { error: "Too many requests" },
          { status: 429 }
        );
      }
      if (error.status === 401) {
        return NextResponse.json(
          { error: "API configuration error" },
          { status: 500 }
        );
      }
      if (error.status === 503) {
        return NextResponse.json(
          {
            error: "AI service temporarily unavailable. Please try again soon.",
          },
          { status: 503 }
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to process table finder request" },
      { status: 500 }
    );
  }
}
