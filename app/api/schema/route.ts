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

    console.log("=== SCHEMA API REQUEST ===");
    console.log("API URL:", apiUrl);

    const response = await fetch(apiUrl);

    if (!response.ok) {
      console.log("Render API error - status:", response.status);
      return NextResponse.json(
        { error: "The URL you entered isn't a Bubble app. Please enter a URL of a Bubble app." },
        { status: 400 }
      );
    }

    let dbml = await response.text();

    console.log("=== DBML FROM RENDER ===");
    console.log("DBML length:", dbml.length);
    console.log("DBML ends with:", dbml.slice(-200)); // Last 200 chars
    console.log("Contains existing Ref:", dbml.includes("Ref:"));

    if (!dbml || dbml.trim().length === 0) {
      console.log("Empty DBML returned");
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

    // Keep existing Ref statements - don't remove them even if table not found
    // (Render API may include valid refs we don't want to remove)
    console.log("Keeping existing Ref statements from Render API");

    // Helper function to find referenced table from field name
    function findReferencedTableForType(fieldName: string): string | null {
      if (!fieldName.endsWith("_id") || fieldName === "id") return null;

      const fieldNameWithoutId = fieldName.slice(0, -3);

      // First, try exact match
      if (definedTables.has(fieldNameWithoutId)) {
        return fieldNameWithoutId;
      }

      // Try with 's' suffix for plurals
      if (definedTables.has(fieldNameWithoutId + "s")) {
        return fieldNameWithoutId + "s";
      }

      // Try splitting by '_' and matching parts from right to left
      const parts = fieldNameWithoutId.split("_");
      for (let i = parts.length - 1; i >= 0; i--) {
        const potentialTable = parts.slice(i).join("_");
        if (definedTables.has(potentialTable)) {
          return potentialTable;
        }
        if (definedTables.has(potentialTable + "s")) {
          return potentialTable + "s";
        }
      }

      return null;
    }

    // Transform _id and _ids fields from "unique" type to their referenced table name
    console.log("=== TRANSFORMING FOREIGN KEY TYPES ===");
    const beforeTransform = dbml;
    let transformCount = 0;

    // Transform list fields: participant_ids unique -> participant_ids participant
    dbml = dbml.replace(/(\w+_ids)\s+unique(?=\s*[\[\n]|$)/gm, (match, fieldName) => {
      const entityName = fieldName.slice(0, -4); // Remove '_ids' suffix
      transformCount++;
      console.log(`[${transformCount}] Transforming ${fieldName}: unique -> ${entityName}`);
      return `${fieldName} ${entityName}`;
    });

    // Transform foreign keys: user_id unique -> user_id user
    dbml = dbml.replace(/(\w+_id)\s+unique(?=\s*[\[\n]|$)/gm, (match, fieldName) => {
      const referencedTable = findReferencedTableForType(fieldName);
      if (referencedTable) {
        transformCount++;
        console.log(`[${transformCount}] Transforming ${fieldName}: unique -> ${referencedTable}`);
        return `${fieldName} ${referencedTable}`;
      }
      return match;
    });

    console.log(`Total transformations: ${transformCount}`);
    console.log("Sample transformed line:", dbml.split("\n").find(line => (line.includes("_id") || line.includes("_ids")) && !line.includes("unique"))?.slice(0, 100));

    const lines = dbml.split("\n");

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

    for (const match of tableMatches2) {
      const tableName = match[1];
      const tableBody = match[2];
      const fieldLines = tableBody.split("\n");

      for (const fieldLine of fieldLines) {
        // Look for fields ending in _id
        const fieldMatch = fieldLine.match(/(\w+)\s+\w+/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const referencedTable = findReferencedTableForType(fieldName);

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
      console.log(`Generated ${generatedRefs.length} relationship references`);
      console.log("Generated Refs:", generatedRefs.slice(0, 5)); // Log first 5 for debugging
      dbml = dbml.trimRight() + "\n\n" + generatedRefs.join("\n");
      console.log("=== FINAL DBML ===");
      console.log("Final DBML ends with:", dbml.slice(-500)); // Last 500 chars to see refs
    } else {
      console.log("No relationship references generated");
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
