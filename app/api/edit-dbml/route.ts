import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

function buildSystemPrompt(currentDbml: string): string {
  return `You are editing a Bubble.io database schema proposal in DBML format.

IMPORTANT: You are editing ONLY the proposed/newly generated schema shown below.
Apply the user's requested changes to these tables only.
Do NOT add new tables unless explicitly requested by the user.

PROPOSED SCHEMA TO EDIT:
${currentDbml}

EDIT OPERATIONS: MODIFY, REMOVE, RENAME fields/tables
- MODIFY: change field names, types, descriptions, add fields to existing tables
- REMOVE: delete fields or tables from the proposal
- RENAME: rename tables or fields

BUBBLE TYPES ONLY: text, number, Y_N (yes/no), date (datetime), unique (primary keys), table names (foreign keys)
Examples: id (unique), user_id (user), post_id (post)
- DO NOT use: int, decimal, boolean, datetime, timestamp, varchar

RULES:
1. Return ONLY valid DBML - no markdown code blocks, no explanations
2. Ensure ALL braces are balanced
3. Include ALL tables from the proposed schema (even ones you don't modify)
4. Use snake_case names - all lowercase with underscores
5. Primary key fields (named "id") use "unique" type - DO NOT add notes to id fields
6. Foreign key fields: {table_name}_id {referenced_table_name}
7. Relationships: > (many-to-one), < (one-to-many), - (one-to-one)
8. Add table and field notes for clarity (but NOT for id/primary key fields)
9. Preserve all existing Ref statements exactly as they are

Return ONLY the complete updated proposal DBML. Nothing else.`;
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

function convertDbmlTypeToBubbleType(dbmlType: string): string {
  const typeMap: { [key: string]: string } = {
    text: "text",
    varchar: "text",
    int: "number",
    integer: "number",
    decimal: "number",
    float: "number",
    double: "number",
    numeric: "number",
    number: "number",
    datetime: "date",
    timestamp: "date",
    date: "date",
    time: "date",
    boolean: "Y_N",
    bool: "Y_N",
    bit: "Y_N",
    y_n: "Y_N",
    unique: "unique",
  };

  const normalized = dbmlType.toLowerCase().trim();
  return typeMap[normalized] || "text";
}

function extractFieldTypesFromDbml(dbml: string): { [tableName: string]: { [fieldName: string]: string } } {
  const fieldTypes: { [tableName: string]: { [fieldName: string]: string } } = {};
  const tableRegex = /Table\s+(?:"([^"]+)"|(\w+))\s*\{([^}]+)\}/g;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(dbml)) !== null) {
    const tableName = tableMatch[1] || tableMatch[2];
    const tableContent = tableMatch[3];
    fieldTypes[tableName] = {};

    const fieldRegex = /(\w+)\s+(\w+(?:\s*<\s*\w+(?:\s*,\s*\w+)*>)?)\s*(?:\[|;|Note:|$)/g;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(tableContent)) !== null) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];

      if (fieldName.toLowerCase() === "note") continue;

      let bubbleType = convertDbmlTypeToBubbleType(fieldType);
      if (fieldName === "id") {
        bubbleType = "unique";
      } else if (fieldName.endsWith("_id")) {
        bubbleType = fieldName.slice(0, -3);
      }

      fieldTypes[tableName][fieldName] = bubbleType;
    }
  }

  return fieldTypes;
}

function convertDbmlToBubbleTypes(dbml: string): string {
  let converted = dbml;
  converted = converted.replace(/\b(decimal|float|double|numeric|integer)\b(?=\s*[\[\n;])/gi, "number");
  converted = converted.replace(/\bbool(?:ean)?\b(?=\s*[\[\n;])/gi, "Y_N");
  converted = converted.replace(/\b(datetime|timestamp|date|time)\b(?=\s*[\[\n;])/gi, "date");
  converted = converted.replace(/\bvarchar\b(?=\s*[\[\n;])/gi, "text");
  converted = converted.replace(/\bint(?:eger)?\b(?=\s*[\[\n;])/gi, "number");
  converted = converted.replace(/(\w*_id)\s+(number|text|int|integer)\b/gi, "$1 unique");
  converted = converted.replace(/\bid\s+(number|text|int|integer)\b/gi, "id unique");
  return converted;
}

function extractTableDescriptions(dbml: string): { [tableName: string]: string } {
  const tableDescriptions: { [tableName: string]: string } = {};
  const tableRegex = /Table\s+(?:"([^"]+)"|(\w+))\s*\{([^}]+)\}/g;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(dbml)) !== null) {
    const tableName = tableMatch[1] || tableMatch[2];
    const tableBody = tableMatch[3];
    const tableNoteMatch = tableBody.match(/^\s*Note:\s*"([^"]+)"/m);
    if (tableNoteMatch) {
      tableDescriptions[tableName] = tableNoteMatch[1];
    }
  }

  return tableDescriptions;
}

export async function POST(request: NextRequest) {
  try {
    const { currentDbml, editInstruction } = await request.json();

    if (!currentDbml) {
      return NextResponse.json({ error: "Current DBML is required" }, { status: 400 });
    }

    if (!editInstruction || editInstruction.trim().length < 5) {
      return NextResponse.json({ error: "Edit instruction too short" }, { status: 400 });
    }

    if (editInstruction.length > 500) {
      return NextResponse.json({ error: "Edit instruction too long" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "API key not configured" }, { status: 500 });
    }

    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: "claude-opus-4-5-20251101",
      max_tokens: 8192,
      temperature: 0.3,
      system: buildSystemPrompt(currentDbml),
      messages: [
        {
          role: "user",
          content: editInstruction,
        },
      ],
    });

    let updatedDbml = message.content[0].type === "text" ? message.content[0].text : "";

    if (!updatedDbml) {
      return NextResponse.json({ error: "No response from AI" }, { status: 500 });
    }

    // Clean up markdown if present
    updatedDbml = updatedDbml.trim();
    if (updatedDbml.startsWith("```")) {
      updatedDbml = updatedDbml.replace(/^```(?:dbml)?\n?/, "").replace(/\n?```$/, "");
    }
    updatedDbml = updatedDbml.trim();

    // Validate
    const validation = validateDbml(updatedDbml);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Invalid DBML: ${validation.error}` },
        { status: 400 }
      );
    }

    // Extract field types and descriptions
    const fieldTypes = extractFieldTypesFromDbml(updatedDbml);
    const tableDescriptions = extractTableDescriptions(updatedDbml);
    const updatedDbmlWithBubbleTypes = convertDbmlToBubbleTypes(updatedDbml);

    return NextResponse.json({
      updatedDbml,
      updatedDbmlWithBubbleTypes,
      fieldTypes,
      tableDescriptions,
    });
  } catch (error) {
    console.error("Error in edit-dbml route:", error);

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
    }

    return NextResponse.json(
      { error: "Failed to process edit" },
      { status: 500 }
    );
  }
}
