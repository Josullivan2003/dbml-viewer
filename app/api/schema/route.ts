/**
 * Schema Fetching API Endpoint
 *
 * PURPOSE:
 * This endpoint takes a Bubble.io app URL and returns the database schema in DBML format.
 * DBML (Database Markup Language) is a simple way to describe database tables and their relationships.
 *
 * WHAT IT DOES:
 * 1. Receives a Bubble app URL from the user
 * 2. Calls an external API to fetch the raw schema from that Bubble app
 * 3. Cleans up the schema data (removes duplicates, fixes broken references)
 * 4. Transforms field types so relationships between tables are clear
 * 5. Returns the cleaned schema that can be visualized as a diagram
 *
 * WHY THIS MATTERS:
 * Bubble.io stores relationships in a non-standard way. A field like "user_id" with type "unique"
 * doesn't tell you which table it links to. This endpoint figures out that "user_id" links to
 * the "user" table and updates the type to show that connection clearly.
 *
 * INPUT: JSON body with "url" field containing a Bubble app URL
 * OUTPUT: JSON with "dbml" field containing the processed schema
 * ERRORS: Returns user-friendly error if URL isn't a valid Bubble app
 */

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
    const apiUrl = `https://xgkxmsaivblwqfkdhtekn3nase0tudjd.lambda-url.us-east-1.on.aws/api/schema/${encodedUrl}?format=dbml`;

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

    // CLEANUP STEP 1: Remove percentage signs
    // Sometimes Bubble's API returns field names with web encoding artifacts like %20
    // We strip these out to keep field names clean and readable
    dbml = dbml.replace(/%/g, "");

    // Check if the DBML contains any table definitions
    if (!dbml.includes("Table ")) {
      return NextResponse.json(
        { error: "The URL you entered isn't a Bubble app. Please enter a URL of a Bubble app." },
        { status: 400 }
      );
    }

    // Build a list of all table names in the schema
    // We need this list to check if relationships point to tables that actually exist
    // For example, if a field references "deleted_user" but that table doesn't exist, we'll remove that reference
    const tableMatches = dbml.matchAll(/Table\s+(?:"([^"]+)"|(\w+))/g);
    const definedTables = new Set();
    for (const match of tableMatches) {
      const tableName = match[1] || match[2];
      if (tableName) definedTables.add(tableName);
    }

    // CLEANUP STEP 2: Remove broken relationship lines
    // Relationship lines (Ref statements) connect tables together in the diagram
    // If a relationship points to a table that doesn't exist, it will cause errors
    // So we remove any relationship lines where the source or target table is missing
    const validatedDbml = dbml.split("\n").filter(line => {
      // Check if this line defines a relationship between tables
      const refMatch = line.match(/Ref:\s*(\w+)\.(\w+)\s*>\s*(\w+)\.(\w+)/);
      if (!refMatch) return true; // Keep lines that aren't relationship definitions

      const sourceTable = refMatch[1]; // The table with the foreign key field
      const targetTable = refMatch[3]; // The table being referenced

      // Only keep this relationship if both tables exist in the schema
      if (!definedTables.has(sourceTable) || !definedTables.has(targetTable)) {
        console.log(`Removing invalid Ref: ${line.trim()} (table not found)`);
        return false;
      }
      return true;
    }).join("\n");

    dbml = validatedDbml;
    console.log("Validated existing Ref statements from Render API");

    // CLEANUP STEP 3: Remove duplicate fields within tables
    // Sometimes Bubble's API returns the same field twice in a table
    // We keep only the first occurrence of each field name to avoid confusion
    console.log("=== REMOVING DUPLICATE COLUMNS ===");
    const lines = dbml.split("\n");
    const processedLines: string[] = [];
    let currentTable = "";
    let seenFields = new Set<string>(); // Tracks which fields we've already seen in current table

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // When we enter a new table, reset our tracking of seen fields
      const tableMatch = line.match(/Table\s+(?:"([^"]+)"|(\w+))/);
      if (tableMatch) {
        currentTable = tableMatch[1] || tableMatch[2];
        seenFields.clear(); // Start fresh for the new table
        processedLines.push(line);
        continue;
      }

      // When we exit a table (closing brace), clear our field tracking
      if (line.trim() === "}") {
        seenFields.clear();
        processedLines.push(line);
        continue;
      }

      // Check if this line defines a field (pattern: fieldname type)
      const fieldMatch = line.match(/^\s*(\w+)\s+\w+/);
      if (fieldMatch && currentTable) {
        const fieldName = fieldMatch[1];

        // Skip duplicate fields - only keep the first occurrence
        if (seenFields.has(fieldName)) {
          console.log(`Removing duplicate column '${fieldName}' from table '${currentTable}'`);
          continue;
        }

        seenFields.add(fieldName);
        processedLines.push(line);
        continue;
      }

      // Keep all other lines (empty lines, comments, relationship statements, etc.)
      processedLines.push(line);
    }

    dbml = processedLines.join("\n");

    /**
     * Smart Table Name Finder
     *
     * Given a field name like "business_owner_id", this function figures out which
     * table in the schema it's linking to.
     *
     * HOW IT WORKS:
     * 1. Removes the "_id" suffix (business_owner_id -> business_owner)
     * 2. Tries to find an exact matching table (e.g., "business_owner" table)
     * 3. If not found, tries adding 's' for plurals (e.g., "business_owners" table)
     * 4. If still not found, tries partial matches from right to left:
     *    - "owner" table, then "owners" table
     *    - This handles prefixed field names like "deleted_user_id" -> "user" table
     *
     * WHY THIS IS NEEDED:
     * Bubble stores foreign keys with generic type "unique" instead of showing which
     * table they link to. This function figures out the actual relationship so we
     * can display it clearly in the diagram.
     */
    function findReferencedTableForType(fieldName: string): string | null {
      // Only process fields that end in _id (but not the primary key "id" itself)
      if (!fieldName.endsWith("_id") || fieldName === "id") return null;

      // Remove the _id suffix to get the base name (user_id -> user)
      const fieldNameWithoutId = fieldName.slice(0, -3);

      // Strategy 1: Try exact match with a table name
      if (definedTables.has(fieldNameWithoutId)) {
        return fieldNameWithoutId;
      }

      // Strategy 2: Try plural form (user -> users)
      if (definedTables.has(fieldNameWithoutId + "s")) {
        return fieldNameWithoutId + "s";
      }

      // Strategy 3: Try partial matches for prefixed field names
      // Example: "deleted_user_id" should match "user" table
      // We split by underscore and try matching from the right side
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

      // No matching table found - this field won't have its type transformed
      return null;
    }

    // CLEANUP STEP 4: Remove orphaned foreign key fields
    // An "orphaned" field is one that references a table that doesn't exist
    // Example: If "deleted_user_id" exists but there's no "deleted_user" table,
    // we remove this field entirely because it would create a broken reference
    // Note: We never remove primary key fields (id or _id) - only foreign key references
    console.log("=== REMOVING ORPHANED FOREIGN KEY FIELDS ===");
    const linesAfterOrphanRemoval: string[] = [];
    let currentTableName = "";
    let orphanCount = 0;

    for (const line of dbml.split("\n")) {
      // Keep track of which table we're currently processing
      const tableMatch = line.match(/Table\s+(?:"([^"]+)"|(\w+))/);
      if (tableMatch) {
        currentTableName = tableMatch[1] || tableMatch[2];
        linesAfterOrphanRemoval.push(line);
        continue;
      }

      // Check if this line defines a field
      const fieldMatch = line.match(/^\s*(\w+)\s+\w+/);
      if (fieldMatch && currentTableName) {
        const fieldName = fieldMatch[1];

        // Never remove primary key fields - they're essential to every table
        const isPrimaryKeyField = fieldName === "id" || fieldName === "_id";

        // Check if this looks like a foreign key field (ends in _id or _ids)
        if (!isPrimaryKeyField && (fieldName.endsWith("_id") || fieldName.endsWith("_ids"))) {
          // Try to figure out which table this field is supposed to link to
          let referencedTable = null;

          if (fieldName.endsWith("_ids")) {
            // List fields (_ids): user_ids should link to "user" table
            const entityName = fieldName.slice(0, -4);
            referencedTable = definedTables.has(entityName) ? entityName : null;
          } else if (fieldName.endsWith("_id")) {
            // Single reference fields (_id): user_id should link to "user" table
            referencedTable = findReferencedTableForType(fieldName);
          }

          // If we can't find a table this field links to, remove it entirely
          if (!referencedTable) {
            orphanCount++;
            console.log(`Removing orphaned field '${fieldName}' from table '${currentTableName}' (referenced table not found)`);
            continue; // Skip this line - don't add it to the output
          }
        }
      }

      linesAfterOrphanRemoval.push(line);
    }

    dbml = linesAfterOrphanRemoval.join("\n");
    console.log(`Removed ${orphanCount} orphaned foreign key fields`);

    // CLEANUP STEP 5: Remove broken inline reference brackets
    // Some fields have inline reference info embedded like: user_id user [ref: > deleted_table._id]
    // If the referenced table doesn't exist, we remove just the [ref: ...] part but keep the field
    // This preserves the field data while removing the broken relationship info
    console.log("=== REMOVING BROKEN INLINE REFS ===");
    let brokenRefCount = 0;
    dbml = dbml.split("\n").map(line => {
      // Look for inline reference syntax: [ref: > tablename._id]
      const inlineRefMatch = line.match(/(\[ref:\s*>\s*(\w+)\._id\])/);
      if (inlineRefMatch) {
        const referencedTable = inlineRefMatch[2];

        // If the table this reference points to doesn't exist, strip out the reference
        if (!definedTables.has(referencedTable)) {
          brokenRefCount++;
          const cleanedLine = line.replace(/\s*\[ref:\s*>\s*\w+\._id\]/, '');
          console.log(`Removing broken inline Ref to table '${referencedTable}': ${line.trim()}`);
          return cleanedLine;
        }
      }
      return line;
    }).join("\n");
    console.log(`Removed ${brokenRefCount} broken inline Refs`);

    // CLEANUP STEP 6: Final validation of relationship statements
    // After all the cleanup above, we do one more pass to catch any remaining broken relationships
    // This is a safety check to ensure the diagram won't have any invalid references
    console.log("=== RE-VALIDATING REF STATEMENTS ===");
    const refValidatedDbml = dbml.split("\n").filter(line => {
      // Check if this line is a standalone relationship definition
      const refMatch = line.match(/Ref:\s*(\w+)\.(\w+)\s*>\s*(\w+)\.(\w+)/);
      if (!refMatch) return true; // Keep all non-relationship lines

      const sourceTable = refMatch[1]; // Table containing the foreign key
      const targetTable = refMatch[3]; // Table being referenced

      // Only keep relationships where both tables still exist after cleanup
      if (!definedTables.has(sourceTable) || !definedTables.has(targetTable)) {
        console.log(`Removing invalid Ref: ${line.trim()} (referenced table not found)`);
        return false;
      }
      return true;
    }).join("\n");

    dbml = refValidatedDbml;

    // TRANSFORMATION: Convert generic "unique" types to show actual table relationships
    // This is the core transformation that makes the schema readable.
    //
    // BEFORE: user_id unique (Bubble's way - doesn't show what table it links to)
    // AFTER:  user_id user   (Clear! This field links to the user table)
    //
    // For list fields:
    // BEFORE: participant_ids unique (multiple references, but to what?)
    // AFTER:  participant_ids participant (Ah, it's a list of participants!)
    console.log("=== TRANSFORMING FOREIGN KEY TYPES ===");
    const beforeTransform = dbml;
    let transformCount = 0;

    // Transform list fields: participant_ids unique -> participant_ids participant
    // These are fields that hold multiple references to another table
    dbml = dbml.replace(/(\w+_ids)\s+unique(?=\s*[\[\n]|$)/gm, (match, fieldName) => {
      const entityName = fieldName.slice(0, -4); // Remove '_ids' to get base table name
      transformCount++;
      console.log(`[${transformCount}] Transforming ${fieldName}: unique -> ${entityName}`);
      return `${fieldName} ${entityName}`;
    });

    // Transform single reference fields: user_id unique -> user_id user
    // These are fields that link to one record in another table
    dbml = dbml.replace(/(\w+_id)\s+unique(?=\s*[\[\n]|$)/gm, (match, fieldName) => {
      const referencedTable = findReferencedTableForType(fieldName);
      if (referencedTable) {
        transformCount++;
        console.log(`[${transformCount}] Transforming ${fieldName}: unique -> ${referencedTable}`);
        return `${fieldName} ${referencedTable}`;
      }
      return match; // Keep as-is if we couldn't find the referenced table
    });

    console.log(`Total transformations: ${transformCount}`);
    console.log("Sample transformed line:", dbml.split("\n").find(line => (line.includes("_id") || line.includes("_ids")) && !line.includes("unique"))?.slice(0, 100));

    // Return the cleaned and transformed schema
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
