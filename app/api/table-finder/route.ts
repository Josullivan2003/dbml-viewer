import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

// Builds the system prompt for table identification and grouping
// This prompt tells Claude to analyze the user's question, identify relevant tables,
// and add a TableGroup definition to the DBML
function buildSystemPrompt(dbml: string): string {
  return `You are a database schema expert analyzing a Bubble.io database schema in DBML format.

CURRENT SCHEMA:
${dbml}

YOUR TASK:
1. The user will ask a question about which tables are involved in a specific feature or workflow
2. Identify ALL tables from the schema that are relevant to answering their question
3. Add a TableGroup to the end of the DBML that groups these related tables together
4. Generate a descriptive name for the TableGroup based on the feature/concept asked about

IMPORTANT RULES:
1. Return ONLY valid DBML - no markdown code blocks, no explanations, no extra text
2. Do NOT modify any existing tables - only ADD a new TableGroup at the end
3. Do NOT add any new tables or fields
4. Ensure ALL braces are balanced
5. The TableGroup must include a Note explaining why these tables are grouped together

TABLEGROUP SYNTAX:
TableGroup "descriptive_name" [color: #FFBD94] {
  table1
  table2
  table3
  Note: '''Brief explanation of the feature or workflow this group represents'''
}

EXAMPLE:
If user asks "What tables handle user authentication?", and you identify user, session, and login_attempt tables:
TableGroup "user_authentication" [color: #FFBD94] {
  user
  session
  login_attempt
  Note: '''Tables involved in user authentication, including user accounts, active sessions, and login tracking'''
}

Return the COMPLETE original DBML followed by the new TableGroup at the end. Nothing else.`;
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
  const tablesSection = groupContent.split("Note:")[0];
  const tables = tablesSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));

  // Extract the explanation from Note:
  const noteMatch = groupContent.match(/Note:\s*'''([^']+)'''/);
  const explanation = noteMatch ? noteMatch[1].trim() : "";

  return { groupName, tables, explanation };
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
      max_tokens: 8192,
      temperature: 0.3,
      system: buildSystemPrompt(dbml),
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    });

    // Extract response text
    let updatedDbml =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!updatedDbml) {
      return NextResponse.json(
        { error: "No response from AI" },
        { status: 500 }
      );
    }

    // Clean up markdown if present
    updatedDbml = updatedDbml.trim();
    if (updatedDbml.startsWith("```")) {
      updatedDbml = updatedDbml
        .replace(/^```(?:dbml)?\n?/, "")
        .replace(/\n?```$/, "");
    }
    updatedDbml = updatedDbml.trim();

    // Validate the returned DBML
    const outputValidation = validateDbml(updatedDbml);
    if (!outputValidation.valid) {
      return NextResponse.json(
        { error: `Invalid DBML generated: ${outputValidation.error}` },
        { status: 400 }
      );
    }

    // Extract TableGroup information from the response
    const tableGroupInfo = extractTableGroupInfo(updatedDbml);
    if (!tableGroupInfo) {
      return NextResponse.json(
        { error: "Failed to extract table group from response" },
        { status: 400 }
      );
    }

    // Validate that all tables in the group actually exist in the schema
    const schemaTableNames = extractTableNames(dbml);
    const invalidTables = tableGroupInfo.tables.filter(
      (table) => !schemaTableNames.includes(table)
    );

    if (invalidTables.length > 0) {
      return NextResponse.json(
        {
          error: `Table group references non-existent tables: ${invalidTables.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Return success response with updated DBML and group details
    return NextResponse.json({
      updatedDbml,
      tableGroupName: tableGroupInfo.groupName,
      matchedTables: tableGroupInfo.tables,
      explanation: tableGroupInfo.explanation,
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
