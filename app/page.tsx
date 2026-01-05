"use client";

import { useState, useEffect } from "react";

interface TableField {
  name: string;
  type: string;
  description?: string;
}

interface SchemaChange {
  newTables: { [tableName: string]: TableField[] };
  newFields: { [tableName: string]: TableField[] };
  tableDescriptions?: { [tableName: string]: string };
}

function convertDbmlToBubbleTypes(dbml: string): string {
  // Replace DBML types with Bubble types in the entire DBML
  let converted = dbml;

  // Replace type declarations: field_name oldType -> field_name newType
  // Do numeric types first (more specific)
  converted = converted.replace(/\b(decimal|float|double|numeric|integer)\b(?=\s*[\[\n;])/gi, 'number');
  converted = converted.replace(/\bbool(?:ean)?\b(?=\s*[\[\n;])/gi, 'Y_N');
  converted = converted.replace(/\b(datetime|timestamp|date|time)\b(?=\s*[\[\n;])/gi, 'date');
  converted = converted.replace(/\bvarchar\b(?=\s*[\[\n;])/gi, 'text');
  converted = converted.replace(/\bint(?:eger)?\b(?=\s*[\[\n;])/gi, 'number');

  // Replace types for fields ending in _id or _ID with "unique"
  converted = converted.replace(/(\w*_id)\s+(number|text|int|integer|unique)\b/gi, '$1 unique');

  // Replace standalone "id" fields with "unique"
  converted = converted.replace(/\bid\s+(number|text|int|integer|unique)\b/gi, 'id unique');

  return converted;
}

function parseDbml(dbml: string): {
  tables: { [key: string]: TableField[] };
  tableNotes: { [tableName: string]: string };
  fieldNotes: { [tableName: string]: { [fieldName: string]: string } };
  raw: string
} {
  const tables: { [key: string]: TableField[] } = {};
  const tableNotes: { [tableName: string]: string } = {};
  const fieldNotes: { [tableName: string]: { [fieldName: string]: string } } = {};

  const tableMatches = dbml.matchAll(/Table\s+(?:"([^"]+)"|(\w+))\s*\{([^}]*)\}/g);

  for (const match of tableMatches) {
    const tableName = match[1] || match[2];
    const tableBody = match[3];
    const fields: TableField[] = [];

    // Extract table-level note
    const tableNoteMatch = tableBody.match(/^\s*Note:\s*"([^"]+)"/m);
    if (tableNoteMatch) {
      tableNotes[tableName] = tableNoteMatch[1];
    }

    // Split table body into lines for better field parsing
    const lines = tableBody.split('\n');

    for (const line of lines) {
      // Skip empty lines and table notes
      if (!line.trim() || line.trim().startsWith('Note:')) continue;

      // Match field definition: field_name type [optional constraints]
      const fieldMatch = line.match(/^\s*(\w+)\s+([^\[\n]+?)(?:\s*\[([^\]]*)\])?$/);
      if (!fieldMatch) continue;

      const fieldName = fieldMatch[1];
      let fieldType = fieldMatch[2].trim();
      const constraints = fieldMatch[3] || "";

      // Skip if not a valid field
      if (!fieldName || !fieldType || fieldName === "Note") continue;

      // Include constraints in the type field to preserve them
      if (constraints) {
        fieldType += ` [${constraints}]`;
      }

      fields.push({ name: fieldName, type: fieldType });

      // Extract field-level note from constraints
      // Match: Note: "any text here"
      const fieldNoteMatch = constraints.match(/Note:\s*"([^"]*?)"/);
      if (fieldNoteMatch && fieldNoteMatch[1]) {
        if (!fieldNotes[tableName]) {
          fieldNotes[tableName] = {};
        }
        fieldNotes[tableName][fieldName] = fieldNoteMatch[1];
      }
    }

    tables[tableName] = fields;
  }

  return { tables, tableNotes, fieldNotes, raw: dbml };
}

function analyzeChanges(
  currentDbml: string,
  proposedDbml: string,
  bubbleFieldTypes?: { [tableName: string]: { [fieldName: string]: string } }
): SchemaChange {
  const current = parseDbml(currentDbml);
  const proposed = parseDbml(proposedDbml);

  const newTables: { [tableName: string]: TableField[] } = {};
  const newFields: { [tableName: string]: TableField[] } = {};
  const tableDescriptions: { [tableName: string]: string } = {};

  console.log("=== ANALYZE CHANGES ===");
  console.log("Current schema tables:", Object.keys(current.tables));
  console.log("Proposed schema tables:", Object.keys(proposed.tables));

  for (const tableName of Object.keys(current.tables)) {
    console.log(`Current ${tableName} fields:`, current.tables[tableName].map(f => f.name).join(', '));
  }
  for (const tableName of Object.keys(proposed.tables)) {
    console.log(`Proposed ${tableName} fields:`, proposed.tables[tableName].map(f => f.name).join(', '));
  }

  // Helper function to clean Note constraints from type field
  const cleanTypeField = (fieldType: string, description?: string): string => {
    // Remove any [Note: "..."] constraints from the type field since we're moving them to description
    let cleaned = fieldType.replace(/,?\s*Note:\s*"[^"]*"/g, '');
    // Clean up any empty brackets
    cleaned = cleaned.replace(/\[\s*,\s*/, '[').replace(/,\s*\]/, ']').replace(/\[\s*\]/, '');
    return cleaned.trim();
  };

  // Find new tables and new fields in existing tables
  for (const [tableName, fields] of Object.entries(proposed.tables)) {
    if (!current.tables[tableName]) {
      // This is a new table - add descriptions from DBML notes
      console.log(`New table: ${tableName}`);
      const fieldsWithDescriptions = fields.map(field => {
        const description = proposed.fieldNotes[tableName]?.[field.name];
        return {
          name: field.name,
          type: cleanTypeField(field.type, description),
          description: description,
        };
      });
      newTables[tableName] = fieldsWithDescriptions;

      // Add table description if it has a note
      if (proposed.tableNotes[tableName]) {
        tableDescriptions[tableName] = proposed.tableNotes[tableName];
      }
    } else {
      // Check for new fields in existing table
      const currentFieldNames = new Set(current.tables[tableName].map(f => f.name));
      const proposedFieldNames = fields.map(f => f.name);
      const added = fields.filter(f => !currentFieldNames.has(f.name));

      console.log(`Table ${tableName}: current fields=${Array.from(currentFieldNames).join(',')}, proposed fields=${proposedFieldNames.join(',')}, added=${added.map(f => f.name).join(',')}`);

      if (added.length > 0) {
        const fieldsWithDescriptions = added.map(field => {
          console.log(`  Added field: ${field.name}`);
          const description = proposed.fieldNotes[tableName]?.[field.name];
          return {
            name: field.name,
            type: cleanTypeField(field.type, description),
            description: description,
          };
        });
        newFields[tableName] = fieldsWithDescriptions;

        // Add table description if it has a note (for modified tables)
        if (proposed.tableNotes[tableName]) {
          tableDescriptions[tableName] = proposed.tableNotes[tableName];
        }
      }
    }
  }

  console.log("=== CHANGE ANALYSIS RESULT ===");
  console.log("New tables:", Object.keys(newTables));
  console.log("Modified tables (with new fields):", Object.keys(newFields));

  return { newTables, newFields, tableDescriptions };
}

const style = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600&family=Playfair+Display:wght@400;500;600&family=DM+Serif+Display&display=swap');

@keyframes gradientMove {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.animated-background {
  background: linear-gradient(-45deg, #ffffff, #ffecd4, #ffd9b3, #ffb366, #ffffff);
  background-size: 400% 400%;
  animation: gradientMove 15s ease infinite;
}

@keyframes aura-enter {
  0% {
    opacity: 0;
    transform: translateY(20px) scale(0.98);
    filter: blur(4px);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
}

.animate-in {
  animation: aura-enter 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.delay-0 { animation-delay: 0s; }
.delay-100 { animation-delay: 0.1s; }
.delay-200 { animation-delay: 0.2s; }
.delay-300 { animation-delay: 0.3s; }
.delay-400 { animation-delay: 0.4s; }

.gradient-input {
  background-image: linear-gradient(#fff, #fff), linear-gradient(to right, #DE5D0D, #F59E0B, #FBBF24, #DE5D0D);
  background-origin: border-box;
  background-clip: padding-box, border-box;
  background-size: 100% 100%, 400% 100%;
  animation: gradientMove 4s ease infinite;
  border: 3px solid transparent;
  box-shadow: 0 0 20px rgba(222, 93, 13, 0.25), 0 4px 16px rgba(0, 0, 0, 0.12);
}

.gradient-input:focus {
  background-image: linear-gradient(#fff, #fff), linear-gradient(to right, #FFBD94, #FFD4B4, #FFECC4, #FFBD94);
  box-shadow: 0 0 25px rgba(255, 189, 148, 0.4), 0 4px 20px rgba(0, 0, 0, 0.15);
}

.hero-texture {
  background-image:
    url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><filter id="noise"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" result="noise"/></filter><rect width="100" height="100" fill="rgb(255,255,255)" filter="url(%23noise)" opacity="0.05"/></svg>');
  background-size: 100px 100px;
}

@keyframes float {
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(20px); }
}

.float-slow {
  animation: float 6s ease-in-out infinite;
}

.float-slower {
  animation: float 8s ease-in-out infinite;
  animation-delay: 1s;
}

.marker-highlight {
  background-image: linear-gradient(120deg, #FFBD94 0%, #FFBD94 100%);
  background-repeat: no-repeat;
  background-size: 100% 40%;
  background-position: 0 85%;
  transition: background-size 0.25s ease-in;
  font-family: 'DM Serif Display', serif;
}

.dm-serif {
  font-family: 'DM Serif Display', serif;
}

.space-grotesk {
  font-family: 'Space Grotesk', sans-serif;
}

* {
  font-family: 'Space Grotesk', sans-serif;
}

@keyframes slide-in-right {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.toast-enter {
  animation: slide-in-right 0.3s ease-out;
}

@media (max-width: 768px) {
  .decorative-circle-top-right {
    transform: translate(70%, -70%) !important;
  }
}
`;

interface FetchState {
  status: "idle" | "loading" | "success" | "error";
  data?: string;
  embedUrl?: string;
  diagramLoading?: boolean;
  iframeError?: boolean;
  error?: string;
  successMessage?: string;
  featurePlanning?: {
    status: "idle" | "planning" | "generating" | "success" | "error";
    description?: string;
    featureTitle?: string;
    originalDbml?: string;
    generatedDbml?: string;
    proposedEmbedUrl?: string;
    error?: string;
    activeView?: "current" | "proposed";
    changes?: SchemaChange;
    editedChanges?: SchemaChange;
    hasInlineEdits?: boolean;
    newTableOrder?: string[];
    newFieldTableOrder?: string[];
    tableNameMap?: { [oldName: string]: string };
  };
}

function convertChangesToDbml(
  preFeatureDbml: string,
  currentGeneratedDbml: string,
  editedChanges: SchemaChange,
  tableNameMap?: { [oldName: string]: string }
): string {
  console.log('=== convertChangesToDbml START ===');
  console.log('🔄 tableNameMap:', tableNameMap);
  console.log('📋 editedChanges structure:');
  console.log('  newTables:', Object.keys(editedChanges.newTables));
  console.log('  newFields:', Object.keys(editedChanges.newFields));

  // Log details of each edited table
  for (const [tableName, fields] of Object.entries(editedChanges.newTables)) {
    console.log(`  newTables.${tableName}: ${fields.length} fields`);
    fields.forEach((f, i) => console.log(`    [${i}] name="${f.name}" type="${f.type}" desc="${f.description || ''}"`));
  }
  for (const [tableName, fields] of Object.entries(editedChanges.newFields)) {
    console.log(`  newFields.${tableName}: ${fields.length} fields`);
    fields.forEach((f, i) => console.log(`    [${i}] name="${f.name}" type="${f.type}" desc="${f.description || ''}"`));
  }

  const preFeature = parseDbml(preFeatureDbml);
  const current = parseDbml(currentGeneratedDbml);
  const dbmlParts: string[] = [];

  // Helper function to check if a table would have any valid fields
  const hasValidFields = (fields: any[]) => {
    return fields.some(f => f.name?.trim() && f.type?.trim());
  };

  // Track which tables have been added
  const addedTables = new Set<string>();

  // Track which tables are being managed by editedChanges (so we don't re-add them as original tables if deleted)
  const managedTables = new Set([
    ...Object.keys(editedChanges.newTables),
    ...Object.keys(editedChanges.newFields),
  ]);

  // Add tables from editedChanges.newTables (these have inline edits)
  for (const [tableName, fields] of Object.entries(editedChanges.newTables)) {
    console.log(`📝 Generating table from newTables "${tableName}": ${fields.length} fields (uses edited version)`);
    fields.forEach((f, i) => console.log(`  [${i}] name="${f.name}" type="${f.type}"`));
    if (!tableName?.trim()) {
      console.log(`⏭️ Skipping table with empty name`);
      continue;
    }
    if (hasValidFields(fields)) {
      // Update field types to reflect renamed tables
      const updatedFields = fields.map(field => {
        const mappedType = tableNameMap?.[field.type] || field.type;
        // Log the type mapping if it changed
        if (mappedType !== field.type) {
          console.log(`  🔄 Field "${field.name}" type mapped: "${field.type}" → "${mappedType}"`);
        }
        return {
          ...field,
          type: mappedType,
        };
      });
      // Log final field types after mapping
      console.log(`  Final fields for "${tableName}":`, updatedFields.map(f => `${f.name}(${f.type})`).join(', '));
      const description = editedChanges.tableDescriptions?.[tableName];
      const generatedTable = generateTableDbml(tableName, updatedFields, description);
      console.log(`✅ Adding table "${tableName}" to DBML`);
      dbmlParts.push(generatedTable);
      addedTables.add(tableName);
    } else {
      console.log(`⏭️ Table "${tableName}" has no valid fields, skipping`);
    }
  }

  // Add modified existing tables (with new fields added via newFields)
  for (const [tableName, newFields] of Object.entries(editedChanges.newFields)) {
    // Skip if already added from newTables
    if (addedTables.has(tableName)) {
      console.log(`ℹ️ Skipping "${tableName}" from newFields - already processed from newTables`);
      continue;
    }
    // If this table was renamed, look up the original fields by the old name
    let lookupTableName = tableName;
    for (const [oldName, newName] of Object.entries(tableNameMap || {})) {
      if (newName === tableName) {
        lookupTableName = oldName;
        console.log(`  🔍 Table "${tableName}" was renamed from "${oldName}", looking up original fields by old name`);
        break;
      }
    }
    const originalFields = current.tables[lookupTableName] || [];
    console.log(`  📦 Original fields for "${lookupTableName}": ${originalFields.length}`);
    const allFields = [...originalFields, ...newFields];
    // Update field types to reflect renamed tables
    const updatedAllFields = allFields.map(field => ({
      ...field,
      type: tableNameMap?.[field.type] || field.type,
    }));
    console.log(`✏️ Generating modified table "${tableName}": ${originalFields.length} original + ${newFields.length} new = ${allFields.length} total`);
    updatedAllFields.forEach((f, i) => console.log(`  [${i}] name="${f.name}" type="${f.type}"`));
    if (hasValidFields(updatedAllFields)) {
      dbmlParts.push(generateTableDbml(tableName, updatedAllFields, current.tableNotes[tableName]));
      addedTables.add(tableName);
    }
  }

  // Add original tables (from pre-feature schema) that haven't been modified or deleted
  // Don't re-add tables that are managed by editedChanges (even if deleted from editedChanges)
  // Check both the original name and any renamed version
  for (const [tableName, fields] of Object.entries(preFeature.tables)) {
    // Check if this table or its renamed version is already being managed
    const isManaged = managedTables.has(tableName) ||
      Object.values(tableNameMap || {}).some(newName => newName === tableName);

    if (!addedTables.has(tableName) && !isManaged) {
      console.log(`📖 Generating original table "${tableName}": ${fields.length} fields (unmodified)`);
      // Update field types to reflect renamed tables
      const updatedFields = fields.map(field => ({
        ...field,
        type: tableNameMap?.[field.type] || field.type,
      }));
      if (hasValidFields(updatedFields)) {
        dbmlParts.push(generateTableDbml(tableName, updatedFields, preFeature.tableNotes[tableName]));
        addedTables.add(tableName);
      }
    } else if (isManaged && !addedTables.has(tableName)) {
      console.log(`ℹ️ Skipping original table "${tableName}" - it's managed by editedChanges (may be deleted or renamed)`);
    }
  }

  // Build a set of all existing fields in the current schema
  const existingFields = new Set<string>();
  for (const [tableName, fields] of Object.entries(editedChanges.newTables)) {
    if (addedTables.has(tableName)) {
      for (const field of fields) {
        if (field.name?.trim()) {
          existingFields.add(`${tableName}.${field.name}`);
        }
      }
    }
  }
  for (const [tableName, fields] of Object.entries(editedChanges.newFields)) {
    if (addedTables.has(tableName)) {
      for (const field of fields) {
        if (field.name?.trim()) {
          existingFields.add(`${tableName}.${field.name}`);
        }
      }
    }
  }
  // Also add original fields from unmodified tables
  for (const [tableName, fields] of Object.entries(preFeature.tables)) {
    if (addedTables.has(tableName) && !managedTables.has(tableName)) {
      for (const field of fields) {
        if (field.name?.trim()) {
          existingFields.add(`${tableName}.${field.name}`);
        }
      }
    }
  }

  // Extract and preserve relationship references (Ref statements) from current DBML
  // But only keep Refs where both tables exist, and the field in the source table exists
  const refMatches = currentGeneratedDbml.matchAll(/Ref:\s*([^\s.]+)\.(\w+)\s*([<>]|-)\s*([^\s.]+)\.(\w+)[^\n]*/g);
  const refs: string[] = [];
  for (const match of refMatches) {
    let sourceTable = match[1];
    const sourceField = match[2];
    let targetTable = match[4];
    const operator = match[3];
    const targetField = match[5];

    // Map old table names to new ones if they were renamed
    sourceTable = tableNameMap?.[sourceTable] || sourceTable;
    targetTable = tableNameMap?.[targetTable] || targetTable;

    // Only include this Ref if both tables exist AND the source field exists
    if (addedTables.has(sourceTable) && addedTables.has(targetTable) && existingFields.has(`${sourceTable}.${sourceField}`)) {
      const refStatement = `Ref: ${sourceTable}.${sourceField} ${operator} ${targetTable}.${targetField}`;
      refs.push(refStatement);
      console.log(`🔗 Keeping Ref: ${sourceTable}.${sourceField} ${operator} ${targetTable}.${targetField}`);
    } else {
      console.log(`⏭️ Removing Ref: ${sourceTable}.${sourceField} ${operator} ${targetTable}.${targetField} (table or field deleted)`);
    }
  }

  console.log('🔗 Refs after filtering:', refs.length);
  refs.forEach((ref, i) => console.log(`  ${i + 1}. ${ref}`));

  // Generate new Refs from fields that reference tables by type
  const bubbleTypes = new Set(['text', 'number', 'Y_N', 'date', 'unique']);
  const existingRefSet = new Set(refs.map(r => {
    const match = r.match(/Ref:\s*([^\s.]+)\.(\w+)\s*([<>]|-)\s*([^\s.]+)\.(\w+)/);
    return match ? `${match[1]}.${match[2]}-${match[4]}.${match[5]}` : '';
  }));

  // Check all fields in newTables and newFields for table references
  const autoGeneratedRefs: string[] = [];

  for (const [tableName, fields] of Object.entries(editedChanges.newTables)) {
    if (!addedTables.has(tableName)) continue;

    for (const field of fields) {
      let fieldType = field.type?.trim();
      // Map renamed tables
      fieldType = tableNameMap?.[fieldType] || fieldType;
      // If the field type is a table name (not a bubble type) and the table exists
      if (fieldType && !bubbleTypes.has(fieldType) && addedTables.has(fieldType)) {
        const refKey = `${tableName}.${field.name}-${fieldType}.id`;
        // Only add if this Ref doesn't already exist
        if (!existingRefSet.has(refKey)) {
          const refStatement = `Ref: ${tableName}.${field.name} > ${fieldType}.id`;
          autoGeneratedRefs.push(refStatement);
          console.log(`🔗 Auto-generating Ref: ${tableName}.${field.name} > ${fieldType}.id`);
        }
      }
    }
  }

  for (const [tableName, newFields] of Object.entries(editedChanges.newFields)) {
    if (!addedTables.has(tableName)) continue;

    for (const field of newFields) {
      let fieldType = field.type?.trim();
      // Map renamed tables
      fieldType = tableNameMap?.[fieldType] || fieldType;
      // If the field type is a table name (not a bubble type) and the table exists
      if (fieldType && !bubbleTypes.has(fieldType) && addedTables.has(fieldType)) {
        const refKey = `${tableName}.${field.name}-${fieldType}.id`;
        // Only add if this Ref doesn't already exist
        if (!existingRefSet.has(refKey)) {
          const refStatement = `Ref: ${tableName}.${field.name} > ${fieldType}.id`;
          autoGeneratedRefs.push(refStatement);
          console.log(`🔗 Auto-generating Ref: ${tableName}.${field.name} > ${fieldType}.id`);
        }
      }
    }
  }

  // Combine existing and auto-generated refs
  const allRefs = [...refs, ...autoGeneratedRefs];
  console.log(`🔗 Total Refs (including auto-generated): ${allRefs.length}`);

  // Extract and preserve TableGroup statements from current DBML
  // Use [\s\S]*? to match multi-line content (dot doesn't match newlines by default)
  const tableGroupMatches = currentGeneratedDbml.matchAll(/TableGroup\s+[^\{]+\{[\s\S]*?\}/g);
  let tableGroups = Array.from(tableGroupMatches).map(m => m[0]);

  console.log('📦 TableGroups extracted:', tableGroups.length);
  tableGroups.forEach((group, i) => console.log(`  ${i + 1}. ${group.split('\n')[0]}`));

  // Update TableGroups to include newly added tables
  if (tableGroups.length > 0 && addedTables.size > 0) {
    tableGroups = tableGroups.map(tableGroup => {
      // Extract the table list from TableGroup (tables are listed one per line or space-separated)
      const tableListMatch = tableGroup.match(/\{\s*([\s\S]*?)\s*(?:Note:|$)/);
      if (!tableListMatch) return tableGroup;

      const tableListContent = tableListMatch[1];
      // Extract table names - they can be comma-separated, space-separated, or on separate lines
      const existingTables = tableListContent
        .split(/[,\s\n]+/)
        .map(t => t.trim())
        .filter(t => t && !t.startsWith('Note'));

      // Keep only tables that still exist in addedTables, and add only newly created/modified tables
      const tablesStillInSchema = existingTables.filter(t => addedTables.has(t));

      // Only add tables that are newly created (newTables) or modified (newFields), not original tables
      const createdOrModifiedTables = new Set([
        ...Object.keys(editedChanges.newTables),
        ...Object.keys(editedChanges.newFields),
      ]);
      const newTablesToAdd = Array.from(createdOrModifiedTables).filter(t => !existingTables.includes(t));
      const allTables = [...new Set([...tablesStillInSchema, ...newTablesToAdd])];

      const removedTables = existingTables.filter(t => !addedTables.has(t));
      console.log(`📦 Updating TableGroup:`);
      console.log(`   Removed tables: ${removedTables.length > 0 ? removedTables.join(', ') : 'none'}`);
      console.log(`   Added new tables: ${newTablesToAdd.length > 0 ? newTablesToAdd.join(', ') : 'none'}`);
      console.log(`   Tables still in schema: ${tablesStillInSchema.join(', ')}`);
      console.log(`   All tables now: ${allTables.join(', ')}`);

      // Rebuild the TableGroup with updated table list (one per line)
      const noteMatch = tableGroup.match(/Note:\s*'''([\s\S]*?)'''/);
      const noteContent = noteMatch ? noteMatch[1] : '';
      const headerMatch = tableGroup.match(/^(TableGroup\s+"[^"]+"\s*(?:\[[^\]]+\])*)\s*\{/);
      const header = headerMatch ? headerMatch[1] : 'TableGroup "Feature"';

      let updatedGroup = `${header} {\n`;
      // Add each table on its own line
      allTables.forEach(table => {
        updatedGroup += `  ${table}\n`;
      });
      if (noteContent) {
        updatedGroup += `  Note: '''${noteContent}'''\n`;
      }
      updatedGroup += '}';

      return updatedGroup;
    });
  }

  // Always include Refs and TableGroups if they exist, even if no tables were added
  let result = dbmlParts.join('\n\n');
  if (allRefs.length > 0) {
    result = result ? `${result}\n\n${allRefs.join('\n')}` : allRefs.join('\n');
  }
  if (tableGroups.length > 0) {
    result = result ? `${result}\n\n${tableGroups.join('\n\n')}` : tableGroups.join('\n\n');
  }

  console.log('✓ Final DBML length:', result.length);
  console.log('✓ Has Ref statements:', result.includes('Ref:'));
  console.log('✓ Has TableGroup statements:', result.includes('TableGroup'));
  console.log('=== convertChangesToDbml END ===');

  return result;
}

function generateTableDbml(
  tableName: string,
  fields: TableField[],
  tableDescription?: string
): string {
  // Quote table names that contain spaces
  const quotedTableName = tableName.includes(' ') ? `"${tableName}"` : tableName;
  let dbml = `Table ${quotedTableName} {\n`;

  if (tableDescription) {
    dbml += `  Note: "${tableDescription}"\n`;
  }

  for (const field of fields) {
    // Skip fields with missing name or type
    if (!field.name?.trim() || !field.type?.trim()) {
      console.log(`⏭️ Skipping field - name: "${field.name}" type: "${field.type}"`);
      continue;
    }

    let fieldName = field.name.trim();
    let fieldType = field.type.trim();

    console.log(`📝 Processing field: ${fieldName} type: ${fieldType} desc: ${field.description || ''}`);

    // Extract existing brackets from type
    const bracketMatch = fieldType.match(/^(.*?)((\s*\[[^\]]*\])*)$/);
    let typeWithoutBrackets = bracketMatch?.[1]?.trim() || fieldType;
    let existingBrackets = (bracketMatch?.[2] || '').trim();

    // Start building the field definition
    let fieldDef = `  ${fieldName} ${typeWithoutBrackets}`;

    // Collect all constraints that should go in brackets
    const constraints: string[] = [];

    // Add primary key constraint if needed
    if (fieldName === 'id' && !existingBrackets.includes('primary key')) {
      constraints.push('primary key');
    }

    // Parse existing constraints from brackets
    if (existingBrackets) {
      const innerContent = existingBrackets.match(/\[([^\]]*)\]/g);
      if (innerContent) {
        innerContent.forEach(bracket => {
          const content = bracket.slice(1, -1); // Remove [ ]
          if (content && !constraints.includes(content)) {
            constraints.push(content);
          }
        });
      }
    }

    // Add description as a note (but not for id/primary key fields)
    // Only add if there isn't already a Note in the constraints
    if (field.description?.trim() && fieldName !== 'id') {
      const hasExistingNote = constraints.some(c => c.startsWith('Note:'));
      if (!hasExistingNote) {
        constraints.push(`Note: "${field.description.trim()}"`);
      }
    }

    // Append all constraints in a single bracket section
    if (constraints.length > 0) {
      fieldDef += ` [${constraints.join(', ')}]`;
    }

    console.log(`  ✅ Generated: ${fieldDef}`);
    dbml += fieldDef + '\n';
  }

  dbml += '}\n';
  return dbml;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [fetchState, setFetchState] = useState<FetchState>({ status: "idle" });
  const [loadingStep, setLoadingStep] = useState(1);
  const [featureDescription, setFeatureDescription] = useState("");
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(384); // w-96 = 384px
  const [isDragging, setIsDragging] = useState(false);
  const [expandedSchemaTables, setExpandedSchemaTables] = useState<Set<string>>(new Set());

  const toggleTable = (tableName: string) => {
    const newExpanded = new Set(expandedTables);
    if (newExpanded.has(tableName)) {
      newExpanded.delete(tableName);
    } else {
      newExpanded.add(tableName);
    }
    setExpandedTables(newExpanded);
  };

  const toggleField = (tableName: string, fieldName: string) => {
    const key = `${tableName}.${fieldName}`;
    const newExpanded = new Set(expandedFields);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedFields(newExpanded);
  };

  const isTableExpanded = (tableName: string) => expandedTables.has(tableName);

  const isFieldExpanded = (tableName: string, fieldName: string) =>
    expandedFields.has(`${tableName}.${fieldName}`);

  const toggleSchemaTable = (tableName: string) => {
    const newExpanded = new Set(expandedSchemaTables);
    if (newExpanded.has(tableName)) {
      newExpanded.delete(tableName);
    } else {
      newExpanded.add(tableName);
    }
    setExpandedSchemaTables(newExpanded);
  };

  const isSchemaTableExpanded = (tableName: string) => expandedSchemaTables.has(tableName);

  const handleMouseDown = () => {
    setIsDragging(true);
  };

  useEffect(() => {
    const handleMouseUp = () => {
      setIsDragging(false);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const container = document.getElementById("diagram-container");
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const newWidth = containerRect.right - e.clientX - 16; // 16 is the gap

      // Set minimum width to 250px and maximum to 70% of container
      const minWidth = 250;
      const maxWidth = containerRect.width * 0.7;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setSidebarWidth(newWidth);
      }
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    if (fetchState.status === "error") {
      const timer = setTimeout(() => {
        setFetchState({ status: "idle" });
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [fetchState.status, fetchState.error]);

  useEffect(() => {
    if (fetchState.successMessage) {
      const timer = setTimeout(() => {
        setFetchState(prev => ({ ...prev, successMessage: undefined }));
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [fetchState.successMessage]);

  useEffect(() => {
    if (fetchState.status === "loading") {
      const step1Timer = setTimeout(() => setLoadingStep(2), 800);
      const step2Timer = setTimeout(() => setLoadingStep(3), 1600);
      return () => {
        clearTimeout(step1Timer);
        clearTimeout(step2Timer);
      };
    } else {
      setLoadingStep(1);
    }
  }, [fetchState.status]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      setFetchState({
        status: "error",
        error: "Please enter a valid URL",
      });
      return;
    }

    setFetchState({ status: "loading" });

    try {
      // Fetch DBML schema
      const response = await fetch("/api/schema", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      const contentType = response.headers.get("content-type");
      if (!contentType?.includes("application/json")) {
        const text = await response.text();
        throw new Error(`API returned non-JSON response: ${response.status} ${response.statusText}\n${text.substring(0, 200)}`);
      }

      const data = await response.json();

      if (!response.ok || !data.dbml) {
        throw new Error(data.error || "No DBML data returned from API");
      }

      // Fetch diagram
      try {
        // Convert DBML to use Bubble types for diagram display
        const dbmlWithBubbleTypes = convertDbmlToBubbleTypes(data.dbml);

        const diagramResponse = await fetch("/api/diagram", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ dbml: dbmlWithBubbleTypes }),
        });

        if (!diagramResponse.ok) {
          throw new Error(
            `Diagram API error: ${diagramResponse.status} ${diagramResponse.statusText}`
          );
        }

        const diagramContentType = diagramResponse.headers.get("content-type");
        if (!diagramContentType?.includes("application/json")) {
          const text = await diagramResponse.text();
          throw new Error(`Diagram API returned non-JSON response: ${text.substring(0, 200)}`);
        }

        const diagramData = await diagramResponse.json();
        console.log("Diagram response:", diagramData);

        setFetchState({
          status: "success",
          data: data.dbml,
          embedUrl: diagramData.embedUrl,
          diagramLoading: false,
        });
      } catch (diagramError) {
        console.error("Failed to create diagram:", diagramError);
        setFetchState({
          status: "success",
          data: data.dbml,
          diagramLoading: false,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";

      setFetchState({
        status: "error",
        error: errorMessage,
      });
    }
  };

  const handlePlanFeature = () => {
    setFetchState(prev => ({
      ...prev,
      featurePlanning: {
        status: "idle",
      },
    }));
    setFeatureDescription("");
  };

  const handleGenerateSchema = async () => {
    if (!featureDescription.trim()) {
      setFetchState(prev => ({
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          status: "error",
          error: "Please enter a feature description",
        },
      }));
      return;
    }

    setFetchState(prev => ({
      ...prev,
      featurePlanning: {
        ...prev.featurePlanning!,
        status: "generating",
        description: featureDescription,
      },
    }));

    try {
      // Call plan-feature API
      const response = await fetch("/api/plan-feature", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentDbml: fetchState.data,
          featureDescription: featureDescription.trim(),
        }),
      });

      const data = await response.json();

      console.log("Raw API response data:", data);
      console.log("fieldTypes in response:", data.fieldTypes);

      if (!response.ok) {
        throw new Error(data.error || "Failed to generate schema");
      }

      // Create diagram for proposed schema (using Bubble types version)
      const diagramResponse = await fetch("/api/diagram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dbml: data.generatedDbmlWithBubbleTypes }),
      });

      if (!diagramResponse.ok) {
        throw new Error("Failed to create diagram for proposed schema");
      }

      const diagramData = await diagramResponse.json();

      // Analyze changes between current and proposed schema
      console.log("=== API RESPONSE ===");
      console.log("fieldTypes exists:", !!data.fieldTypes);
      console.log("fieldTypes:", data.fieldTypes);

      const changes = analyzeChanges(
        fetchState.data || "",
        data.generatedDbml,
        data.fieldTypes
      );
      console.log("=== CHANGES RESULT ===");
      console.log("newTables comments fields:", changes.newTables?.comments?.map(f => ({ name: f.name, type: f.type })));

      setFetchState(prev => ({
        ...prev,
        successMessage: "Schema generated!",
        featurePlanning: {
          status: "success",
          description: featureDescription,
          featureTitle: data.featureTitle || featureDescription,
          originalDbml: fetchState.data,
          generatedDbml: data.generatedDbml,
          proposedEmbedUrl: diagramData.embedUrl,
          activeView: "proposed",
          changes,
          editedChanges: JSON.parse(JSON.stringify(changes)),
          newTableOrder: Object.keys(changes.newTables),
          newFieldTableOrder: Object.keys(changes.newFields),
          hasInlineEdits: false,
        },
      }));
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to generate schema";

      setFetchState(prev => ({
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          status: "error",
          error: errorMessage,
        },
      }));
    }
  };

  const handleToggleView = (view: "current" | "proposed") => {
    setFetchState(prev => ({
      ...prev,
      featurePlanning: {
        ...prev.featurePlanning!,
        activeView: view,
      },
    }));
  };

  const handleClosePlanning = () => {
    setFetchState(prev => ({
      ...prev,
      featurePlanning: {
        status: "idle",
      },
    }));
    setFeatureDescription("");
  };

  const handleTableNameChange = (
    oldName: string,
    newName: string,
    section: 'newTables' | 'newFields'
  ) => {
    if (!newName.trim()) return;

    setFetchState(prev => {
      const sectionChanges = { ...prev.featurePlanning!.editedChanges![section] };
      sectionChanges[newName] = sectionChanges[oldName];
      delete sectionChanges[oldName];

      // Also update table descriptions if the old name has a description
      const tableDescriptions = { ...prev.featurePlanning!.editedChanges!.tableDescriptions };
      if (tableDescriptions[oldName]) {
        tableDescriptions[newName] = tableDescriptions[oldName];
        delete tableDescriptions[oldName];
      }

      const editedChanges = {
        ...prev.featurePlanning!.editedChanges!,
        [section]: sectionChanges,
        tableDescriptions,
      };

      // Update order array - replace oldName with newName at the same position
      const orderKey = section === 'newTables' ? 'newTableOrder' : 'newFieldTableOrder';
      let currentOrder = (prev.featurePlanning?.[orderKey as keyof typeof prev.featurePlanning] as string[] | undefined) || [];

      // If order array is empty, initialize it with current table names (excluding the old name)
      if (currentOrder.length === 0) {
        currentOrder = Object.keys(sectionChanges).filter(t => t !== newName);
      }

      const newOrder = currentOrder.map(t => t === oldName ? newName : t);
      // Ensure new name is in the order if not already there
      if (!newOrder.includes(newName)) {
        newOrder.push(newName);
      }

      // Track the table name change in tableNameMap
      const tableNameMap = { ...prev.featurePlanning?.tableNameMap };
      tableNameMap[oldName] = newName;

      return {
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          editedChanges,
          hasInlineEdits: true,
          [orderKey]: newOrder,
          tableNameMap,
        },
      };
    });
  };

  const handleFieldChange = (
    tableName: string,
    fieldIndex: number,
    property: 'name' | 'type' | 'description',
    value: string,
    section: 'newTables' | 'newFields'
  ) => {
    setFetchState(prev => {
      const fields = prev.featurePlanning!.editedChanges![section][tableName];
      const updatedFields = fields.map((field, idx) =>
        idx === fieldIndex ? { ...field, [property]: value } : field
      );

      const editedChanges = {
        ...prev.featurePlanning!.editedChanges!,
        [section]: {
          ...prev.featurePlanning!.editedChanges![section],
          [tableName]: updatedFields,
        },
      };

      return {
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          editedChanges,
          hasInlineEdits: true,
        },
      };
    });
  };

  const handleDeleteField = (
    tableName: string,
    fieldIndex: number,
    section: 'newTables' | 'newFields'
  ) => {
    setFetchState(prev => {
      const fields = prev.featurePlanning!.editedChanges![section][tableName];
      const updatedFields = fields.filter((_, idx) => idx !== fieldIndex);

      const sectionChanges = { ...prev.featurePlanning!.editedChanges![section] };

      if (updatedFields.length === 0) {
        delete sectionChanges[tableName];
      } else {
        sectionChanges[tableName] = updatedFields;
      }

      const editedChanges = {
        ...prev.featurePlanning!.editedChanges!,
        [section]: sectionChanges,
      };

      return {
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          editedChanges,
          hasInlineEdits: true,
        },
      };
    });
  };

  const handleDeleteTable = (
    tableName: string,
    section: 'newTables' | 'newFields'
  ) => {
    setFetchState(prev => {
      const sectionChanges = { ...prev.featurePlanning!.editedChanges![section] };
      delete sectionChanges[tableName];

      const editedChanges = {
        ...prev.featurePlanning!.editedChanges!,
        [section]: sectionChanges,
      };

      // Also remove from expandedSchemaTables
      const newExpanded = new Set(expandedSchemaTables);
      newExpanded.delete(tableName);
      setExpandedSchemaTables(newExpanded);

      // Remove from order array
      const orderKey = section === 'newTables' ? 'newTableOrder' : 'newFieldTableOrder';
      const currentOrder = (prev.featurePlanning?.[orderKey as keyof typeof prev.featurePlanning] as string[] | undefined) || [];
      const newOrder = currentOrder.filter(t => t !== tableName);

      return {
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          editedChanges,
          hasInlineEdits: true,
          [orderKey]: newOrder,
        },
      };
    });
  };

  const handleAddField = (
    tableName: string,
    section: 'newTables' | 'newFields'
  ) => {
    setFetchState(prev => {
      const editedChanges = {
        ...prev.featurePlanning!.editedChanges!,
        [section]: {
          ...prev.featurePlanning!.editedChanges![section],
          [tableName]: [
            ...prev.featurePlanning!.editedChanges![section][tableName],
            { name: 'new_field', type: 'text', description: '' },
          ],
        },
      };

      return {
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          editedChanges,
          hasInlineEdits: true,
        },
      };
    });
  };

  const handleAddTable = () => {
    let finalName = 'new_table';
    const newTableName = 'new_table';
    let counter = 1;

    setFetchState(prev => {
      const currentNewTables = prev.featurePlanning!.editedChanges!.newTables;

      // Find a unique name
      while (currentNewTables[finalName]) {
        finalName = `${newTableName}_${counter}`;
        counter++;
      }

      const editedChanges = {
        ...prev.featurePlanning!.editedChanges!,
        newTables: {
          ...currentNewTables,
          [finalName]: [
            { name: 'id', type: 'unique', description: 'Primary key' },
          ],
        },
      };

      const newTableOrder = [...(prev.featurePlanning?.newTableOrder || []), finalName];

      return {
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          editedChanges,
          hasInlineEdits: true,
          newTableOrder,
        },
      };
    });

    setExpandedSchemaTables(prev => new Set([...prev, finalName]));
  };

  const handleUpdateDiagram = async () => {
    try {
      setFetchState(prev => ({
        ...prev,
        featurePlanning: {
          ...prev.featurePlanning!,
          status: 'generating',
        },
      }));

      console.log('\n🔄 === HANDLE UPDATE DIAGRAM START ===');
      console.log('Current editedChanges:', fetchState.featurePlanning!.editedChanges);

      // Convert edited changes back to DBML using JavaScript logic
      // Use pre-feature schema to know which tables are original, and current generated schema to preserve structure/Refs/TableGroups
      const updatedDbml = convertChangesToDbml(
        fetchState.featurePlanning!.originalDbml || '',
        fetchState.featurePlanning!.generatedDbml || '',
        fetchState.featurePlanning!.editedChanges!,
        fetchState.featurePlanning!.tableNameMap
      );

      // Convert to Bubble types for the diagram API
      const updatedDbmlWithBubbleTypes = convertDbmlToBubbleTypes(updatedDbml);

      console.log('📊 Generated DBML:');
      console.log('  Length:', updatedDbml.length);
      console.log('  Full content:');
      console.log(updatedDbml);
      console.log('  With Bubble types:');
      console.log(updatedDbmlWithBubbleTypes);

      // Validate DBML syntax
      const openBraces = (updatedDbmlWithBubbleTypes.match(/\{/g) || []).length;
      const closeBraces = (updatedDbmlWithBubbleTypes.match(/\}/g) || []).length;
      if (openBraces !== closeBraces) {
        throw new Error(`Unbalanced braces in DBML: ${openBraces} open, ${closeBraces} close`);
      }

      // Check for duplicate tables
      const tableMatches = Array.from(updatedDbmlWithBubbleTypes.matchAll(/Table\s+(?:"([^"]+)"|(\w+))\s*\{/g));
      const tableNames = tableMatches.map(m => m[1] || m[2]);
      const duplicates = tableNames.filter((t, i) => tableNames.indexOf(t) !== i);
      if (duplicates.length > 0) {
        throw new Error(`Duplicate tables in DBML: ${[...new Set(duplicates)].join(', ')}`);
      }
      console.log(`✅ DBML validation passed: ${tableNames.length} unique tables, braces balanced`);

      // Generate diagram
      const diagramResponse = await fetch('/api/diagram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbml: updatedDbmlWithBubbleTypes }),
      });

      if (!diagramResponse.ok) {
        const error = await diagramResponse.json();
        throw new Error(error.error || 'Failed to generate diagram');
      }

      const diagramData = await diagramResponse.json();

      setFetchState(prev => ({
        ...prev,
        successMessage: 'Diagram updated!',
        featurePlanning: {
          ...prev.featurePlanning!,
          status: 'success',
          generatedDbml: updatedDbml,
          proposedEmbedUrl: diagramData.embedUrl,
          hasInlineEdits: false,
        },
      }));
    } catch (error) {
      console.error('Error updating diagram:', error);
      setFetchState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to update diagram',
        status: 'error',
        featurePlanning: {
          ...prev.featurePlanning!,
          status: 'success',
        },
      }));
    }
  };

  return (
    <>
      <style>{style}</style>
      <main className="min-h-screen w-full relative overflow-hidden flex flex-col" style={{background: 'linear-gradient(to bottom, #ffffff 0%, #FFF6F0 100%)'}}>
        {/* Animated Background */}
        <div className="fixed inset-0 -z-20 animated-background opacity-80 pointer-events-none"></div>
        <div className="fixed inset-0 -z-10 pointer-events-none" style={{backgroundImage: 'linear-gradient(to right, rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.04) 1px, transparent 1px)', backgroundSize: '80px 80px', maskImage: 'linear-gradient(to bottom, black 40%, transparent 100%)'}}></div>

        {/* Decorative Circle - Top Right */}
        <div className="fixed top-0 right-0 -z-5 pointer-events-none decorative-circle-top-right" style={{width: '600px', height: '600px', borderRadius: '50%', background: 'linear-gradient(135deg, #FFBD94 0%, rgba(255, 189, 148, 0) 100%)', transform: 'translate(40%, -40%)'}}></div>

        {/* Decorative Circle - Bottom Left */}
        <div className="fixed bottom-0 left-0 -z-5 pointer-events-none" style={{width: '600px', height: '600px', borderRadius: '50%', background: 'linear-gradient(135deg, #FFBD94 0%, rgba(255, 189, 148, 0) 100%)', transform: 'translate(-60%, 60%)'}}></div>

        {/* Hero Texture */}
        <div className="absolute top-0 left-0 right-0 h-full hero-texture opacity-60 pointer-events-none -z-5"></div>

        {/* Decorative floating elements */}
        <div className="absolute top-10 left-10 w-72 h-72 bg-blue-200 rounded-full mix-blend-multiply filter blur-3xl opacity-20 pointer-events-none float-slow"></div>
        <div className="absolute top-40 right-10 w-72 h-72 bg-purple-200 rounded-full mix-blend-multiply filter blur-3xl opacity-20 pointer-events-none float-slower"></div>
        <div className="absolute -bottom-8 left-20 w-72 h-72 bg-pink-200 rounded-full mix-blend-multiply filter blur-3xl opacity-20 pointer-events-none float-slow"></div>

        <div className={`flex flex-col w-full ${fetchState.status === "success" ? "max-w-[80vw]" : "max-w-6xl"} mx-auto relative ${fetchState.status === "success" ? "items-stretch" : "items-center"} ${fetchState.status === "success" ? "p-4 md:p-8 pt-4" : "p-4 md:p-8 pt-12 md:pt-20"}`}>
            {fetchState.status !== "success" && (
              <>
                <a href="https://userflo.co" target="_blank" rel="noopener noreferrer" className="animate-in delay-100 flex flex-col items-center gap-2 mb-4 hover:opacity-70 transition-opacity">
                  <img src="/logo.png" alt="Userflo logo" className="h-10 w-10" />
                  <span className="text-sm font-medium text-zinc-600">Built by Userflo</span>
                </a>
                <div className="flex-none text-center w-full max-w-3xl z-20">
                {/* Heading */}
                <h1 className="animate-in delay-200 dm-serif text-3xl sm:text-4xl lg:text-5xl font-normal text-zinc-900 leading-[1.05] tracking-wide mb-4">
                  <span className="marker-highlight inline-block px-1 transform -rotate-1">Visualise</span> Your Bubble App's <br />
                  Database.
                </h1>

                {/* Subheading */}
                <p className="animate-in delay-300 text-lg text-zinc-500 leading-relaxed max-w-lg mx-auto mb-8 font-medium">
                  View your app's database as an interactive diagram, completely free.
                </p>
              </div>
              </>
            )}

            {/* Input Form */}
            {fetchState.status !== "success" && (
            <div className="animate-in delay-400 w-full max-w-2xl flex-none z-30 mb-2">
              <form onSubmit={handleSubmit} className="w-full">
                <div className="relative flex rounded-xl overflow-hidden gradient-input">
                  <input
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="Enter your Bubble app's URL (e.g., bubble.io)"
                    className="flex-1 outline-none placeholder:text-zinc-400 text-sm font-medium text-zinc-800 py-4 px-4 bg-white border-0 rounded-l-[9px]"
                    disabled={fetchState.status === "loading"}
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={fetchState.status === "loading"}
                    className="px-5 py-0.5 m-1 bg-zinc-900 text-white hover:bg-zinc-800 transition-all shadow-sm active:scale-95 disabled:bg-zinc-400 font-medium text-sm flex items-center gap-2 rounded-[9px]"
                  >
                    {fetchState.status === "loading" ? (
                      <>
                        <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></div>
                        Loading
                      </>
                    ) : (
                      <>
                        View
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
            )}

            {/* Loading States */}
            {fetchState.status === "loading" && (
              <div className="w-full max-w-2xl mt-6 flex-none">
                <div className="flex items-center gap-4 justify-center flex-wrap">
                  {/* Step 1: Connecting */}
                  <div className="flex items-center gap-2">
                    <div className={`flex items-center justify-center w-5 h-5 rounded-full transition-colors ${loadingStep > 1 ? "bg-orange-500" : loadingStep === 1 ? "bg-orange-500" : "bg-zinc-300"}`}>
                      {loadingStep > 1 ? (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : loadingStep === 1 ? (
                        <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></div>
                      ) : null}
                    </div>
                    <span className={`text-xs transition-colors ${loadingStep >= 1 ? "text-zinc-700 font-medium" : "text-zinc-400"}`}>Connecting</span>
                  </div>

                  {/* Divider */}
                  <div className="w-6 h-px bg-zinc-300"></div>

                  {/* Step 2: Extracting */}
                  <div className="flex items-center gap-2">
                    <div className={`flex items-center justify-center w-5 h-5 rounded-full transition-colors ${loadingStep > 2 ? "bg-orange-500" : loadingStep === 2 ? "bg-orange-500" : "bg-zinc-300"}`}>
                      {loadingStep > 2 ? (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : loadingStep === 2 ? (
                        <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></div>
                      ) : null}
                    </div>
                    <span className={`text-xs transition-colors ${loadingStep >= 2 ? "text-zinc-700 font-medium" : "text-zinc-400"}`}>Extracting</span>
                  </div>

                  {/* Divider */}
                  <div className="w-6 h-px bg-zinc-300"></div>

                  {/* Step 3: Visualizing */}
                  <div className="flex items-center gap-2">
                    <div className={`flex items-center justify-center w-5 h-5 rounded-full transition-colors ${loadingStep > 3 ? "bg-orange-500" : loadingStep === 3 ? "bg-orange-500" : "bg-zinc-300"}`}>
                      {loadingStep > 3 ? (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : loadingStep === 3 ? (
                        <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></div>
                      ) : null}
                    </div>
                    <span className={`text-xs transition-colors ${loadingStep >= 3 ? "text-zinc-700 font-medium" : "text-zinc-400"}`}>Visualizing</span>
                  </div>
                </div>
              </div>
            )}

            {/* Reviews Section */}
            {fetchState.status !== "success" && (
            <section className="pt-2 pb-12 w-full max-w-6xl">
              <div className="relative flex items-center justify-center py-12 sm:py-20" style={{ minHeight: '450px' }}>
                <div className="relative flex justify-center items-center w-full h-full gap-0">
                  {/* Card 1 */}
                  <div className="relative w-80 h-72 bg-white rounded-2xl border border-neutral-200 shadow-xl overflow-hidden transition-all duration-300 hover:shadow-2xl hover:scale-105" style={{ margin: '0 -50px', transform: 'rotate(-10deg)' }}>
                    <div className="p-6 flex flex-col h-full bg-white text-neutral-900">
                      <div className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-neutral-100 ring-1 ring-neutral-200 mb-4">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-neutral-700">
                          <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path>
                          <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path>
                        </svg>
                      </div>
                      <p className="text-sm leading-relaxed text-neutral-900 mb-4 flex-1">
                        Finally, a way to visualize my Bubble database structure instantly. Saved me hours of documenting and made onboarding new team members so much easier.
                      </p>
                      <div className="pt-3 border-t border-neutral-200 flex items-center justify-between mt-auto">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 rounded-full bg-neutral-300"></div>
                          <div>
                            <div className="text-xs font-medium text-neutral-900">Sarah Chen</div>
                            <div className="text-xs text-neutral-500">Bubble Developer</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-amber-400">
                            <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"></path>
                          </svg>
                          <span className="text-xs font-medium">5.0</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Card 2 */}
                  <div className="relative w-80 h-72 bg-white rounded-2xl border border-neutral-200 shadow-xl overflow-hidden transition-all duration-300 hover:shadow-2xl hover:scale-105" style={{ margin: '0 -50px', transform: 'rotate(-6deg)' }}>
                    <div className="p-6 flex flex-col h-full bg-white text-neutral-900">
                      <div className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-neutral-100 ring-1 ring-neutral-200 mb-4">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-neutral-700">
                          <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path>
                          <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path>
                        </svg>
                      </div>
                      <p className="text-sm leading-relaxed text-neutral-900 mb-4 flex-1">
                        Perfect for sharing database architecture with clients and investors without exposing the entire app. Free and incredibly fast.
                      </p>
                      <div className="pt-3 border-t border-neutral-200 flex items-center justify-between mt-auto">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 rounded-full bg-neutral-300"></div>
                          <div>
                            <div className="text-xs font-medium text-neutral-900">James Mitchell</div>
                            <div className="text-xs text-neutral-500">Product Manager</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-amber-400">
                            <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"></path>
                          </svg>
                          <span className="text-xs font-medium">5.0</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Card 3 */}
                  <div className="relative w-80 h-72 bg-white rounded-2xl border border-neutral-200 shadow-xl overflow-hidden transition-all duration-300 hover:shadow-2xl hover:scale-105 hidden md:flex" style={{ margin: '0 -50px', transform: 'rotate(0deg)' }}>
                    <div className="p-6 flex flex-col h-full bg-white text-neutral-900">
                      <div className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-neutral-100 ring-1 ring-neutral-200 mb-4">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-neutral-700">
                          <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path>
                          <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path>
                        </svg>
                      </div>
                      <p className="text-sm leading-relaxed text-neutral-900 mb-4 flex-1">
                        Integrates perfectly into our development workflow. The visual representation catches database issues we would've missed during reviews.
                      </p>
                      <div className="pt-3 border-t border-neutral-200 flex items-center justify-between mt-auto">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 rounded-full bg-neutral-300"></div>
                          <div>
                            <div className="text-xs font-medium text-neutral-900">Elena Rodriguez</div>
                            <div className="text-xs text-neutral-500">Tech Lead</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-amber-400">
                            <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"></path>
                          </svg>
                          <span className="text-xs font-medium">5.0</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            )}
        </div>

        {/* Toast Notifications */}
        {fetchState.status === "error" && (
          <div className="fixed top-4 right-4 bg-red-500 text-white px-6 py-4 rounded-lg shadow-lg max-w-sm z-50 toast-enter">
            <p className="text-sm font-medium">{fetchState.error}</p>
          </div>
        )}

        {fetchState.successMessage && (
          <div className="fixed top-4 right-4 bg-green-500 text-white px-6 py-4 rounded-lg shadow-lg max-w-sm z-50 toast-enter">
            <p className="text-sm font-medium">{fetchState.successMessage}</p>
          </div>
        )}

        {fetchState.status === "success" && fetchState.data && (
          <>
            <div className="flex-1 flex flex-col w-full max-w-[80vw] mx-auto bg-white/40 backdrop-blur-xl rounded-lg overflow-hidden border border-white/20 shadow-xl relative z-10" style={{backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.4) 100%)', boxShadow: '0 8px 32px rgba(31, 38, 135, 0.15), inset 0 0 0 1px rgba(255,255,255,0.3)'}}>
              {fetchState.diagramLoading && (
                <div className="flex-1 flex flex-col items-center justify-center gap-4">
                  <div className="flex gap-2">
                    <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                    <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                    <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                  </div>
                  <p className="text-zinc-600 text-sm">Creating diagram...</p>
                </div>
              )}

              {!fetchState.diagramLoading && (
                <div id="diagram-container" className="flex-1 flex flex-row p-4 bg-zinc-100 gap-4">
                  {/* Diagram Section */}
                  <div className="flex-1 flex flex-col min-w-0">
                    {/* Back Button and Current/Proposed Tabs */}
                    <div className="flex gap-2 mb-3 justify-between items-center">
                      <div className="flex gap-2 w-fit items-center">
                        <button
                          onClick={() => setFetchState({ status: "idle" })}
                          className="flex items-center justify-center w-10 h-10 rounded-lg bg-white border-2 border-orange-500 hover:bg-orange-50 transition-colors flex-shrink-0"
                          aria-label="Go back"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-500">
                            <polyline points="15 18 9 12 15 6"></polyline>
                          </svg>
                        </button>
                        {fetchState.featurePlanning?.status === "success" && (
                          <>
                            <button
                              onClick={() => handleToggleView("current")}
                              className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                                fetchState.featurePlanning.activeView === "current"
                                  ? "bg-zinc-900 text-white"
                                  : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                              }`}
                            >
                              Current
                            </button>
                            <button
                              onClick={() => handleToggleView("proposed")}
                              className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                                fetchState.featurePlanning.activeView === "proposed"
                                  ? "bg-zinc-900 text-white"
                                  : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                              }`}
                            >
                              {fetchState.featurePlanning.featureTitle || "Proposed"}
                            </button>
                          </>
                        )}
                      </div>

                      {/* Plan Another Button - Top Right */}
                      {fetchState.featurePlanning?.status === "success" && (
                        <button
                          onClick={handlePlanFeature}
                          className="px-4 py-2 bg-zinc-900 text-white text-xs font-medium rounded-lg hover:bg-zinc-800 transition-colors flex-shrink-0"
                        >
                          + Plan Feature
                        </button>
                      )}
                    </div>

                    {fetchState.iframeError ? (
                      <div className="flex-1 p-12 flex items-center justify-center">
                        <p className="text-zinc-600 text-sm">The diagram encountered an error while loading. This may be due to invalid database structure. Please try with a different app.</p>
                      </div>
                    ) : (
                      <>
                        {/* Show current schema by default, or proposed if feature planning is active */}
                        {fetchState.featurePlanning?.status === "success" && fetchState.featurePlanning.activeView === "proposed" ? (
                          <>
                            {fetchState.featurePlanning.proposedEmbedUrl ? (
                              <iframe
                                key={fetchState.featurePlanning.proposedEmbedUrl}
                                src={fetchState.featurePlanning.proposedEmbedUrl}
                                className="w-full flex-1 border-0 rounded-[9px]"
                                title="Proposed Database Diagram"
                                loading="lazy"
                                allow="fullscreen"
                              />
                            ) : (
                              <div className="flex-1 p-12 flex items-center justify-center">
                                <p className="text-zinc-600 text-sm">Proposed diagram could not be loaded.</p>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {fetchState.embedUrl ? (
                              <iframe
                                src={fetchState.embedUrl}
                                className="w-full flex-1 border-0 rounded-[9px]"
                                title="Database Diagram"
                                loading="lazy"
                                allow="fullscreen"
                                onError={() => setFetchState(prev => ({...prev, iframeError: true}))}
                              />
                            ) : (
                              <div className="flex-1 p-12 flex items-center justify-center">
                                <p className="text-zinc-600 text-sm">Diagram could not be loaded. Check browser console for details.</p>
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>

                  {/* Resizable Divider */}
                  <div
                    onMouseDown={handleMouseDown}
                    className={`w-1 bg-zinc-300 hover:bg-orange-400 cursor-col-resize transition-colors ${isDragging ? "bg-orange-400" : ""}`}
                    style={{ userSelect: "none" }}
                  />

                  {/* AI Recommendations Section */}
                  <div
                    className="flex flex-col bg-white/40 backdrop-blur-xl rounded-[9px] p-3 border border-white/20 overflow-y-auto max-h-[calc(100vh-200px)]"
                    style={{
                      width: `${sidebarWidth}px`,
                      minWidth: "250px",
                      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.3)'
                    }}
                  >
                    <h3 className="font-semibold text-sm text-zinc-900 mb-4">AI Insights</h3>

                    {/* Idle State */}
                    {!fetchState.featurePlanning || fetchState.featurePlanning.status === "idle" ? (
                      <div className="flex-1 flex flex-col space-y-3">
                        <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-2">
                          <p className="text-xs text-blue-800">
                            <strong>Note:</strong> This generates a proposed schema for planning purposes. You'll need to manually implement these changes in your Bubble app.
                          </p>
                        </div>
                        <textarea
                          value={featureDescription}
                          onChange={(e) => setFeatureDescription(e.target.value)}
                          placeholder="Describe the feature you want to add..."
                          className="w-full p-3 border border-zinc-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-zinc-900"
                          rows={4}
                        />
                        <button
                          onClick={handleGenerateSchema}
                          className="w-full px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors"
                        >
                          Generate Schema
                        </button>
                      </div>
                    ) : null}

                    {/* Planning State - Not used since we show input in Idle */}

                    {/* Generating State */}
                    {fetchState.featurePlanning?.status === "generating" && (
                      <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                        <div className="flex gap-2">
                          <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                          <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                          <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                        </div>
                        <p className="text-xs text-zinc-600 text-center">Generating schema...</p>
                      </div>
                    )}

                    {/* Success State */}
                    {fetchState.featurePlanning?.status === "success" && (
                      <div className="flex-1 flex flex-col space-y-3 overflow-y-auto">
                        {/* Changes Summary */}
                        {fetchState.featurePlanning!.editedChanges && (Object.keys(fetchState.featurePlanning!.editedChanges.newTables).length > 0 || Object.keys(fetchState.featurePlanning!.editedChanges.newFields).length > 0) && (
                          <div className="bg-orange-50 border border-orange-200 rounded-lg p-2.5 space-y-2">
                            <p className="text-xs font-bold text-orange-900 px-1">Schema Changes</p>

                            {Object.keys(fetchState.featurePlanning!.editedChanges!.newTables).length > 0 && (
                              <div className="space-y-1">
                                <p className="text-xs font-semibold text-orange-800 px-1">New Tables</p>
                                {(fetchState.featurePlanning?.newTableOrder?.length ? fetchState.featurePlanning.newTableOrder : Object.keys(fetchState.featurePlanning!.editedChanges!.newTables)).map((tableName, index) => {
                                  const fields = fetchState.featurePlanning!.editedChanges!.newTables[tableName];
                                  if (!fields) return null;
                                  return (
                                  <div key={`newTable-${index}`} className="bg-white border border-orange-200 rounded overflow-hidden">
                                    <div className="w-full px-2 py-1 bg-orange-100 border-b border-orange-200 hover:bg-orange-150 transition-colors flex items-start gap-2">
                                      <button
                                        onClick={() => toggleSchemaTable(tableName)}
                                        className="flex-1 flex items-start gap-2 text-left"
                                      >
                                        <span className="text-orange-700 font-semibold text-xs mt-0.5 min-w-3">
                                          {isSchemaTableExpanded(tableName) ? "▼" : "►"}
                                        </span>
                                        <div className="flex-1">
                                          <input
                                            type="text"
                                            value={tableName}
                                            onChange={(e) => handleTableNameChange(tableName, e.target.value, 'newTables')}
                                            onClick={(e) => e.stopPropagation()}
                                            className="text-xs font-bold text-orange-900 bg-transparent border-b border-transparent hover:border-orange-400 focus:border-orange-500 focus:outline-none px-1"
                                          />
                                          {fetchState.featurePlanning!.editedChanges!.tableDescriptions?.[tableName] && (
                                            <p className="text-xs text-orange-700 italic mt-0.5 leading-tight">{fetchState.featurePlanning!.editedChanges!.tableDescriptions[tableName]}</p>
                                          )}
                                        </div>
                                      </button>
                                      <button
                                        onClick={() => handleDeleteTable(tableName, 'newTables')}
                                        className="text-red-500 hover:text-red-700 text-xs flex-shrink-0"
                                        title="Delete table"
                                      >
                                        🗑️
                                      </button>
                                    </div>
                                    {isSchemaTableExpanded(tableName) && (
                                      <table className="w-full text-xs border-collapse">
                                        <thead>
                                          <tr className="border-b border-orange-300 bg-orange-50">
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Column</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-1/5">Type</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Description</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-10">Actions</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {fields.map((field, fieldIndex) => (
                                            <tr key={`${tableName}-${fieldIndex}`} className="border-b border-orange-100 hover:bg-orange-50 transition-colors">
                                              <td className="px-2 py-1">
                                                <input
                                                  type="text"
                                                  value={field.name}
                                                  onChange={(e) => handleFieldChange(tableName, fieldIndex, 'name', e.target.value, 'newTables')}
                                                  className="w-full font-semibold text-orange-800 text-xs bg-transparent border-b border-transparent hover:border-orange-300 focus:border-orange-500 focus:outline-none"
                                                />
                                              </td>
                                              <td className="px-2 py-1">
                                                <select
                                                  value={field.type}
                                                  onChange={(e) => handleFieldChange(tableName, fieldIndex, 'type', e.target.value, 'newTables')}
                                                  className="w-full text-orange-700 text-xs bg-white border border-orange-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-orange-500"
                                                >
                                                  <option value="">Select type</option>
                                                  <optgroup label="Data Types">
                                                    <option value="text">text</option>
                                                    <option value="number">number</option>
                                                    <option value="Y_N">Y_N</option>
                                                    <option value="date">date</option>
                                                    <option value="unique">unique</option>
                                                  </optgroup>
                                                  <optgroup label="Tables">
                                                    {Array.from(
                                                      new Set([
                                                        ...Object.keys(fetchState.featurePlanning?.editedChanges?.newTables || {}),
                                                        ...Object.keys(fetchState.featurePlanning?.editedChanges?.newFields || {}),
                                                        ...(fetchState.data ? Object.keys(parseDbml(fetchState.data).tables) : []),
                                                      ])
                                                    )
                                                      .filter(t => t !== tableName)
                                                      .sort()
                                                      .map(table => (
                                                        <option key={table} value={table}>
                                                          {table}
                                                        </option>
                                                      ))}
                                                  </optgroup>
                                                </select>
                                              </td>
                                              <td className="px-2 py-1">
                                                <input
                                                  type="text"
                                                  value={field.description || ""}
                                                  placeholder="-"
                                                  onChange={(e) => handleFieldChange(tableName, fieldIndex, 'description', e.target.value, 'newTables')}
                                                  className="w-full text-orange-600 italic text-xs bg-transparent border-b border-transparent hover:border-orange-300 focus:border-orange-500 focus:outline-none"
                                                />
                                              </td>
                                              <td className="px-2 py-1">
                                                <button
                                                  onClick={() => handleDeleteField(tableName, fieldIndex, 'newTables')}
                                                  className="text-red-500 hover:text-red-700 text-xs"
                                                  title="Delete field"
                                                >
                                                  🗑️
                                                </button>
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                        <tfoot>
                                          <tr>
                                            <td colSpan={4} className="px-2 py-1">
                                              <button
                                                onClick={() => handleAddField(tableName, 'newTables')}
                                                className="w-full text-xs text-orange-600 hover:text-orange-800 py-1 flex items-center justify-center gap-1"
                                              >
                                                <span>+</span> Add Column
                                              </button>
                                            </td>
                                          </tr>
                                        </tfoot>
                                      </table>
                                    )}
                                  </div>
                                  );
                                })}
                                <button
                                  onClick={handleAddTable}
                                  className="w-full mt-2 px-3 py-2 bg-orange-100 text-orange-800 text-xs font-medium rounded-lg hover:bg-orange-200 transition-colors flex items-center justify-center gap-1"
                                >
                                  <span>+</span> Add Table
                                </button>
                              </div>
                            )}

                            {Object.keys(fetchState.featurePlanning!.editedChanges!.newFields).length > 0 && (
                              <div className="space-y-1 pt-1">
                                <p className="text-xs font-semibold text-orange-800 px-1">Modified Tables</p>
                                {(fetchState.featurePlanning?.newFieldTableOrder?.length ? fetchState.featurePlanning.newFieldTableOrder : Object.keys(fetchState.featurePlanning!.editedChanges!.newFields)).map((tableName, index) => {
                                  const fields = fetchState.featurePlanning!.editedChanges!.newFields[tableName];
                                  if (!fields) return null;
                                  return (
                                  <div key={`newField-${index}`} className="bg-white border border-orange-200 rounded overflow-hidden">
                                    <div className="w-full px-2 py-1 bg-orange-100 border-b border-orange-200 hover:bg-orange-150 transition-colors flex items-start gap-2">
                                      <button
                                        onClick={() => toggleSchemaTable(tableName)}
                                        className="flex-1 flex items-start gap-2 text-left"
                                      >
                                        <span className="text-orange-700 font-semibold text-xs mt-0.5 min-w-3">
                                          {isSchemaTableExpanded(tableName) ? "▼" : "►"}
                                        </span>
                                        <div className="flex-1">
                                          <input
                                            type="text"
                                            value={tableName}
                                            onChange={(e) => handleTableNameChange(tableName, e.target.value, 'newFields')}
                                            onClick={(e) => e.stopPropagation()}
                                            className="text-xs font-bold text-orange-900 bg-transparent border-b border-transparent hover:border-orange-400 focus:border-orange-500 focus:outline-none px-1"
                                          />
                                          {fetchState.featurePlanning!.editedChanges!.tableDescriptions?.[tableName] && (
                                            <p className="text-xs text-orange-700 italic mt-0.5 leading-tight">{fetchState.featurePlanning!.editedChanges!.tableDescriptions[tableName]}</p>
                                          )}
                                        </div>
                                      </button>
                                      <button
                                        onClick={() => handleDeleteTable(tableName, 'newFields')}
                                        className="text-red-500 hover:text-red-700 text-xs flex-shrink-0"
                                        title="Delete table"
                                      >
                                        🗑️
                                      </button>
                                    </div>
                                    {isSchemaTableExpanded(tableName) && (
                                      <table className="w-full text-xs border-collapse">
                                        <thead>
                                          <tr className="border-b border-orange-300 bg-orange-50">
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Column</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-1/5">Type</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Description</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-10">Actions</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {fields.map((field, fieldIndex) => (
                                            <tr key={`${tableName}-newFields-${fieldIndex}`} className="border-b border-orange-100 hover:bg-orange-50 transition-colors">
                                              <td className="px-2 py-1">
                                                <input
                                                  type="text"
                                                  value={field.name}
                                                  onChange={(e) => handleFieldChange(tableName, fieldIndex, 'name', e.target.value, 'newFields')}
                                                  className="w-full font-semibold text-orange-800 text-xs bg-transparent border-b border-transparent hover:border-orange-300 focus:border-orange-500 focus:outline-none"
                                                />
                                              </td>
                                              <td className="px-2 py-1">
                                                <select
                                                  value={field.type}
                                                  onChange={(e) => handleFieldChange(tableName, fieldIndex, 'type', e.target.value, 'newFields')}
                                                  className="w-full text-orange-700 text-xs bg-white border border-orange-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-orange-500"
                                                >
                                                  <option value="">Select type</option>
                                                  <optgroup label="Data Types">
                                                    <option value="text">text</option>
                                                    <option value="number">number</option>
                                                    <option value="Y_N">Y_N</option>
                                                    <option value="date">date</option>
                                                    <option value="unique">unique</option>
                                                  </optgroup>
                                                  <optgroup label="Tables">
                                                    {Array.from(
                                                      new Set([
                                                        ...Object.keys(fetchState.featurePlanning?.editedChanges?.newTables || {}),
                                                        ...Object.keys(fetchState.featurePlanning?.editedChanges?.newFields || {}),
                                                        ...(fetchState.data ? Object.keys(parseDbml(fetchState.data).tables) : []),
                                                      ])
                                                    )
                                                      .filter(t => t !== tableName)
                                                      .sort()
                                                      .map(table => (
                                                        <option key={table} value={table}>
                                                          {table}
                                                        </option>
                                                      ))}
                                                  </optgroup>
                                                </select>
                                              </td>
                                              <td className="px-2 py-1">
                                                <input
                                                  type="text"
                                                  value={field.description || ""}
                                                  placeholder="-"
                                                  onChange={(e) => handleFieldChange(tableName, fieldIndex, 'description', e.target.value, 'newFields')}
                                                  className="w-full text-orange-600 italic text-xs bg-transparent border-b border-transparent hover:border-orange-300 focus:border-orange-500 focus:outline-none"
                                                />
                                              </td>
                                              <td className="px-2 py-1">
                                                <button
                                                  onClick={() => handleDeleteField(tableName, fieldIndex, 'newFields')}
                                                  className="text-red-500 hover:text-red-700 text-xs"
                                                  title="Delete field"
                                                >
                                                  🗑️
                                                </button>
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                        <tfoot>
                                          <tr>
                                            <td colSpan={4} className="px-2 py-1">
                                              <button
                                                onClick={() => handleAddField(tableName, 'newFields')}
                                                className="w-full text-xs text-orange-600 hover:text-orange-800 py-1 flex items-center justify-center gap-1"
                                              >
                                                <span>+</span> Add Column
                                              </button>
                                            </td>
                                          </tr>
                                        </tfoot>
                                      </table>
                                    )}
                                  </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}

                        {fetchState.featurePlanning?.hasInlineEdits && (
                          <button
                            onClick={handleUpdateDiagram}
                            className="w-full mt-3 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                          >
                            Update Diagram
                          </button>
                        )}

                        {/* Edit Schema Section */}
                        <div className="border-t pt-4 space-y-2">
                          <p className="text-xs font-semibold text-zinc-700">Quick Edit</p>
                          <textarea
                            id="schema-edit-input"
                            placeholder="e.g., Add session_id field to users table"
                            maxLength={300}
                            className="w-full px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 resize-none"
                            rows={2}
                          />
                          <button
                            onClick={async () => {
                              const input = document.getElementById("schema-edit-input") as HTMLTextAreaElement;
                              if (!input?.value.trim()) return;

                              const button = event?.target as HTMLButtonElement;
                              const originalText = button.textContent;
                              button.disabled = true;
                              button.textContent = "Updating...";

                              try {
                                // Step 1: Get updated DBML from Claude
                                const editResponse = await fetch("/api/edit-dbml", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    currentDbml: fetchState.featurePlanning?.generatedDbml,
                                    editInstruction: input.value,
                                  }),
                                });

                                if (!editResponse.ok) {
                                  throw new Error("Failed to process edit");
                                }

                                const editData = await editResponse.json();

                                // Step 2: Generate new diagram
                                const diagramResponse = await fetch("/api/diagram", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    dbml: editData.updatedDbmlWithBubbleTypes,
                                  }),
                                });

                                let newEmbedUrl = "";
                                if (diagramResponse.ok) {
                                  const diagramData = await diagramResponse.json();
                                  newEmbedUrl = diagramData.embedUrl;
                                } else {
                                  // Fallback if diagram API fails
                                  newEmbedUrl = `https://dbdiagram.io/embed/${encodeURIComponent(editData.updatedDbmlWithBubbleTypes)}`;
                                }

                                // Step 3: Analyze changes (compare against original schema)
                                const changes = analyzeChanges(
                                  fetchState.featurePlanning?.originalDbml || "",
                                  editData.updatedDbml,
                                  editData.fieldTypes
                                );

                                // Step 4: Update state
                                setFetchState(prev => {
                                  // Helper to check if a table has valid fields
                                  const hasValidFields = (fields: any[]) => {
                                    return fields.some(f => f.name?.trim() && f.type?.trim());
                                  };

                                  // Merge newly analyzed changes with existing inline edits
                                  // Keep API changes for existing tables, preserve only truly new inline-created tables
                                  const previousEdits = prev.featurePlanning?.editedChanges;

                                  const mergedNewTables = { ...changes.newTables };
                                  for (const [tableName, fields] of Object.entries(previousEdits?.newTables || {})) {
                                    // Only preserve if not in API changes AND has valid fields
                                    if (!changes.newTables[tableName] && hasValidFields(fields)) {
                                      console.log(`📝 Preserving inline-created table: ${tableName}`);
                                      mergedNewTables[tableName] = fields;
                                    }
                                  }

                                  const mergedNewFields = { ...changes.newFields };
                                  for (const [tableName, fields] of Object.entries(previousEdits?.newFields || {})) {
                                    // Only preserve if not in API changes AND has valid fields
                                    if (!changes.newFields[tableName] && hasValidFields(fields)) {
                                      console.log(`📝 Preserving inline-created fields for: ${tableName}`);
                                      mergedNewFields[tableName] = fields;
                                    }
                                  }

                                  const editedChanges = {
                                    newTables: mergedNewTables,
                                    newFields: mergedNewFields,
                                    tableDescriptions: {
                                      ...changes.tableDescriptions,
                                      ...(previousEdits?.tableDescriptions || {}),
                                    },
                                  };

                                  console.log('🔀 Merged editedChanges after Apply Edit:', editedChanges);

                                  return {
                                    ...prev,
                                    successMessage: "Schema updated!",
                                    featurePlanning: {
                                      ...prev.featurePlanning!,
                                      generatedDbml: editData.updatedDbml,
                                      proposedEmbedUrl: newEmbedUrl,
                                      activeView: "proposed",
                                      changes,
                                      editedChanges,
                                      newTableOrder: Object.keys(editedChanges.newTables),
                                      newFieldTableOrder: Object.keys(editedChanges.newFields),
                                      tableNameMap: {}, // Reset table name map after Apply Edit
                                      hasInlineEdits: false,
                                    },
                                  };
                                });

                                input.value = "";
                              } catch (error) {
                                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                                setFetchState(prev => ({
                                  ...prev,
                                  error: errorMessage,
                                  status: "error",
                                }));
                              } finally {
                                button.disabled = false;
                                button.textContent = originalText;
                              }
                            }}
                            className="w-full px-4 py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 disabled:bg-gray-400 transition-colors"
                          >
                            Apply Edit
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Error State */}
                    {fetchState.featurePlanning?.status === "error" && (
                      <div className="flex-1 flex flex-col space-y-3">
                        <div className="bg-red-50 border border-red-200 rounded p-3">
                          <p className="text-xs text-red-800">{fetchState.featurePlanning.error || "Failed to generate schema"}</p>
                        </div>
                        <button
                          onClick={handlePlanFeature}
                          className="w-full px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors"
                        >
                          Try Again
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-center gap-2 mt-6 pb-4">
              <img src="/logo.png" alt="Userflo logo" className="h-6 w-6" />
              <span className="text-sm font-medium text-zinc-600">Built by Userflo</span>
            </div>
          </>
        )}

      </main>
    </>
  );
}
