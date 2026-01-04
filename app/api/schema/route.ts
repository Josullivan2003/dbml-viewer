import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json(
        { error: "URL is required" },
        { status: 400 }
      );
    }

    const encodedUrl = encodeURIComponent(url);
    const apiUrl = `https://bubble-schema-api.onrender.com/api/schema/${encodedUrl}?format=dbml`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
      return NextResponse.json(
        { error: "The URL you entered isn't a Bubble app. Please enter a URL of a Bubble app." },
        { status: 400 }
      );
    }

    let dbml = await response.text();

    if (!dbml || dbml.trim().length === 0) {
      return NextResponse.json(
        { error: "The URL you entered isn't a Bubble app. Please enter a URL of a Bubble app." },
        { status: 400 }
      );
    }

    // Remove all percentage signs
    dbml = dbml.replace(/%/g, "");

    // Check if the DBML contains any table definitions
    if (!dbml.includes("Table ")) {
      return NextResponse.json(
        { error: "The URL you entered isn't a Bubble app. Please enter a URL of a Bubble app." },
        { status: 400 }
      );
    }

    // Extract all table names defined in the DBML
    const tableMatches = dbml.match(/Table\s+"([^"]+)"/g) || [];
    const definedTables = new Set(tableMatches.map(match => match.replace(/Table\s+"([^"]+)"/, "$1")));

    // Remove references to tables that don't exist
    const lines = dbml.split("\n");
    const filteredLines = lines.filter(line => {
      const refMatch = line.match(/Ref:\s*(\w+)\./);
      if (refMatch) {
        const referencedTable = refMatch[1];
        if (!definedTables.has(referencedTable)) {
          console.log(`Removing invalid reference to table: ${referencedTable}`);
          return false; // Remove this line
        }
      }
      return true;
    });
    dbml = filteredLines.join("\n");

    // Generate missing relationships from foreign key fields
    // Extract all fields and generate Ref statements for _id fields
    const tableMatches2 = dbml.matchAll(/Table\s+"([^"]+)"\s*\{([^}]*)\}/g);
    const generatedRefs: string[] = [];
    const existingRefs = new Set();

    // Collect existing Ref statements
    dbml.split("\n").forEach(line => {
      const refMatch = line.match(/Ref:\s*(\w+)\.(\w+)\s*>\s*(\w+)\.(\w+)/);
      if (refMatch) {
        existingRefs.add(`${refMatch[1]}.${refMatch[2]}-${refMatch[3]}.${refMatch[4]}`);
      }
    });

    // Helper function to find referenced table from field name
    function findReferencedTable(fieldName: string): string | null {
      if (!fieldName.endsWith("_id") || fieldName === "id") return null;

      const fieldNameWithoutId = fieldName.slice(0, -3);

      // First, try exact match (e.g., session_id -> sessions, user_id -> user)
      if (definedTables.has(fieldNameWithoutId)) {
        return fieldNameWithoutId;
      }

      // Try with 's' suffix (e.g., session_id -> sessions)
      if (definedTables.has(fieldNameWithoutId + "s")) {
        return fieldNameWithoutId + "s";
      }

      // Try removing last word and matching (e.g., creator_user_id -> user)
      const parts = fieldNameWithoutId.split("_");
      for (let i = parts.length - 1; i >= 0; i--) {
        const potentialTable = parts.slice(i).join("_");
        if (definedTables.has(potentialTable)) {
          return potentialTable;
        }
        // Try with 's' suffix
        if (definedTables.has(potentialTable + "s")) {
          return potentialTable + "s";
        }
      }

      return null;
    }

    for (const match of tableMatches2) {
      const tableName = match[1];
      const tableBody = match[2];
      const fieldLines = tableBody.split("\n");

      for (const fieldLine of fieldLines) {
        // Look for fields ending in _id
        const fieldMatch = fieldLine.match(/(\w+)\s+\w+/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const referencedTable = findReferencedTable(fieldName);

          if (referencedTable) {
            const refKey = `${tableName}.${fieldName}-${referencedTable}.id`;
            if (!existingRefs.has(refKey)) {
              generatedRefs.push(`Ref: ${tableName}.${fieldName} > ${referencedTable}.id`);
            }
          }
        }
      }
    }

    // Add generated refs to DBML if any
    if (generatedRefs.length > 0) {
      dbml = dbml.trimRight() + "\n\n" + generatedRefs.join("\n");
    }

    return NextResponse.json({ dbml });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
