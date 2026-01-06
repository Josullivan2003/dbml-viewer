"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";

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

// Message structure for chat-based database queries
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  schemaContext: "current" | "proposed";
}

// Message structure for table finder (identifying which tables are involved in features)
interface TableFinderMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  tableGroups?: string[];
  matchedTables?: string[];
}

function dedupDbml(dbml: string): string {
  // Remove duplicate field definitions within tables and duplicate Ref statements
  console.log('=== DEDUPLICATING DBML ===');
  const lines = dbml.split('\n');
  const processedLines: string[] = [];
  let currentTable = '';
  let seenFields = new Set<string>();
  let seenRefs = new Set<string>();

  for (const line of lines) {
    // Track which table we're currently in
    const tableMatch = line.match(/Table\s+(?:"([^"]+)"|(\w+))/);
    if (tableMatch) {
      currentTable = tableMatch[1] || tableMatch[2];
      seenFields.clear();
      processedLines.push(line);
      continue;
    }

    // Check if we're exiting a table
    if (line.trim() === '}') {
      seenFields.clear();
      processedLines.push(line);
      continue;
    }

    // Check for duplicate field definitions within the current table
    const fieldMatch = line.match(/^\s*(\w+)\s+\w+/);
    if (fieldMatch && currentTable) {
      const fieldName = fieldMatch[1];
      if (seenFields.has(fieldName)) {
        console.log(`Removing duplicate field '${fieldName}' from table '${currentTable}'`);
        continue;
      }
      seenFields.add(fieldName);
    }

    // Check for duplicate Ref statements
    const refMatch = line.match(/Ref:\s*([^\s.]+)\.(\w+)\s*([<>]|-)\s*([^\s.]+)\._id/);
    if (refMatch) {
      const refKey = `${refMatch[1]}.${refMatch[2]}-${refMatch[4]}._id`;
      if (seenRefs.has(refKey)) {
        console.log(`Removing duplicate Ref: ${line.trim()}`);
        continue;
      }
      seenRefs.add(refKey);
    }

    processedLines.push(line);
  }

  return processedLines.join('\n');
}

// Generate a short summary from a question for tab titles
// E.g., "Show me tables involved in managing PA availability" -> "PA availability"
function generateSummaryFromQuestion(question: string): string {
  // Remove common prefixes like "Show me", "What", "Which", "Tell me about"
  let summary = question
    .replace(/^(show me|what|which|tell me about|what are|which are|find|identify)\s+/i, '')
    .replace(/\?$/, '') // Remove trailing question mark
    .trim();

  // Remove common phrases
  summary = summary
    .replace(/\s+(tables|involved in|are the|related to|for|in|the|that)\s+/gi, ' ')
    .trim();

  // Limit to reasonable length
  if (summary.length > 40) {
    summary = summary.substring(0, 40) + '...';
  }

  return summary || 'Tables';
}

function convertDbmlToBubbleTypes(dbml: string): string {
  // Replace DBML types with Bubble types in the entire DBML
  let converted = dbml;

  // Handle inline Ref relationships: field_name text [ref: > table._id]
  // Replace the field's type with the referenced table name
  // Pattern: any word characters (field), any type, [ref: > table._id] -> replace type with table name
  converted = converted.replace(/(\w+)\s+\w+\s+(\[ref:\s*>\s*(\w+)\.)/g, '$1 $3 $2');

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
      // Only count fields that don't exist in current, ignoring formatting/constraint changes
      const currentFieldNames = new Set(current.tables[tableName].map(f => f.name));
      const proposedFieldNames = fields.map(f => f.name);

      // Fields that are in proposed but not in current = truly new fields
      const added = fields.filter(f => !currentFieldNames.has(f.name));

      console.log(`Table ${tableName}: current fields=${Array.from(currentFieldNames).join(',')}, proposed fields=${proposedFieldNames.join(',')}, truly_added=${added.map(f => f.name).join(',')}`);

      // Only mark as modified if there are truly new fields (not just reformatted existing ones)
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
      } else {
        // Table exists with same fields - no changes detected
        console.log(`  Table ${tableName} has no new fields (existing fields may be reformatted but not modified)`);
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
  // State for chat-based database queries feature
  chatWithDb?: {
    status: "idle" | "chatting" | "error";
    messages: ChatMessage[];
    currentSchemaContext: "current" | "proposed" | null;
    activeTab: "plan-feature" | "chat-db" | "table-finder";
    error?: string;
  };
  // State for table finder feature (identifying tables involved in features)
  tableFinder?: {
    status: "idle" | "searching" | "success" | "error";
    messages: TableFinderMessage[];
    results: Array<{
      id: string;
      question: string;
      summary: string;
      matchedTables: string[];
      embedUrl: string;
      dbml: string;
      explanation: string;
    }>;
    activeResultId?: string;
    error?: string;
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
  // Normalize both _id and id to _id for consistent deduplication
  const existingRefSet = new Set(refs.map(r => {
    const match = r.match(/Ref:\s*([^\s.]+)\.(\w+)\s*([<>]|-)\s*([^\s.]+)\.(\w+)/);
    if (match) {
      // Normalize target field to _id
      const targetField = match[5] === 'id' ? '_id' : match[5];
      return `${match[1]}.${match[2]}-${match[4]}.${targetField}`;
    }
    return '';
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
        const refKey = `${tableName}.${field.name}-${fieldType}._id`;
        // Only add if this Ref doesn't already exist
        if (!existingRefSet.has(refKey)) {
          const refStatement = `Ref: ${tableName}.${field.name} > ${fieldType}._id`;
          autoGeneratedRefs.push(refStatement);
          console.log(`🔗 Auto-generating Ref: ${tableName}.${field.name} > ${fieldType}._id`);
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
        const refKey = `${tableName}.${field.name}-${fieldType}._id`;
        // Only add if this Ref doesn't already exist
        if (!existingRefSet.has(refKey)) {
          const refStatement = `Ref: ${tableName}.${field.name} > ${fieldType}._id`;
          autoGeneratedRefs.push(refStatement);
          console.log(`🔗 Auto-generating Ref: ${tableName}.${field.name} > ${fieldType}._id`);
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

  // Remove any duplicate fields and references
  const deduplicatedResult = dedupDbml(result);

  console.log('=== convertChangesToDbml END ===');

  return deduplicatedResult;
}

function convertProposalToDbml(
  generatedDbml: string,
  editedChanges: SchemaChange,
  tableNameMap?: { [oldName: string]: string }
): string {
  // Generate DBML containing ONLY the newly generated/modified tables (the proposal)
  // This excludes original unmodified tables, so the edit-dbml API can't accidentally modify them
  console.log('=== convertProposalToDbml START ===');
  const dbmlParts: string[] = [];
  const generated = parseDbml(generatedDbml);

  // Helper function to check if a table would have any valid fields
  const hasValidFields = (fields: any[]) => {
    return fields.some(f => f.name?.trim() && f.type?.trim());
  };

  // Track which tables we've added
  const addedTables = new Set<string>();

  // Add tables from editedChanges.newTables (newly created tables)
  for (const [tableName, fields] of Object.entries(editedChanges.newTables)) {
    console.log(`📝 Adding new table "${tableName}" to proposal DBML: ${fields.length} fields`);
    if (!tableName?.trim()) continue;
    if (hasValidFields(fields)) {
      // Update field types to reflect renamed tables
      const updatedFields = fields.map(field => ({
        ...field,
        type: tableNameMap?.[field.type] || field.type,
      }));
      const description = editedChanges.tableDescriptions?.[tableName];
      const generatedTable = generateTableDbml(tableName, updatedFields, description);
      dbmlParts.push(generatedTable);
      addedTables.add(tableName);
    }
  }

  // Add modified existing tables (tables that got new fields added)
  // Include the complete table from generated schema + the new fields
  for (const [tableName, newFields] of Object.entries(editedChanges.newFields)) {
    if (addedTables.has(tableName)) {
      console.log(`⏭️ Skipping "${tableName}" - already added from newTables`);
      continue;
    }
    console.log(`📝 Adding modified table "${tableName}" to proposal DBML: ${newFields.length} new fields`);

    // Get the complete table from the generated schema (has both original and new fields from inline edits)
    const generatedFields = generated.tables[tableName] || [];
    const allFields = [...generatedFields, ...newFields];

    // Update field types to reflect renamed tables
    const updatedFields = allFields.map(field => ({
      ...field,
      type: tableNameMap?.[field.type] || field.type,
    }));
    if (hasValidFields(updatedFields)) {
      const description = generated.tableNotes[tableName] || editedChanges.tableDescriptions?.[tableName];
      const generatedTable = generateTableDbml(tableName, updatedFields, description);
      dbmlParts.push(generatedTable);
      addedTables.add(tableName);
    }
  }

  // Extract Ref statements from the generated schema for the proposal tables
  const refs: string[] = [];
  const proposalTableSet = new Set([...addedTables]);

  // Extract all Ref statements from generated DBML that involve proposal tables
  const refRegex = /Ref:\s*([^\s.]+)\.(\w+)\s*([<>]|-)\s*([^\s.]+)\.(\w+)/g;
  let refMatch;
  const seenRefs = new Set<string>();

  while ((refMatch = refRegex.exec(generatedDbml)) !== null) {
    const sourceTable = refMatch[1];
    const targetTable = refMatch[4];

    // Include this ref if either table is in the proposal
    if (proposalTableSet.has(sourceTable) || proposalTableSet.has(targetTable)) {
      const refKey = `${sourceTable}.${refMatch[2]}-${targetTable}.${refMatch[5]}`;
      if (!seenRefs.has(refKey)) {
        const direction = refMatch[3];
        refs.push(`Ref: ${sourceTable}.${refMatch[2]} ${direction} ${targetTable}.${refMatch[5]}`);
        seenRefs.add(refKey);
      }
    }
  }

  const result = dbmlParts.join('\n\n');
  if (refs.length > 0) {
    return result ? `${result}\n\n${refs.join('\n')}` : refs.join('\n');
  }

  console.log('=== convertProposalToDbml END ===');
  return dedupDbml(result);
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

  // Auto-scroll to bottom of chat when new messages arrive
  useEffect(() => {
    if (fetchState.chatWithDb?.messages.length && fetchState.chatWithDb.activeTab === "chat-db") {
      const chatContainer = document.getElementById("chat-messages");
      if (chatContainer) {
        // Use setTimeout to ensure the DOM has updated before scrolling
        setTimeout(() => {
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }, 0);
      }
    }
  }, [fetchState.chatWithDb?.messages.length, fetchState.chatWithDb?.activeTab]);

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

      let data;
      try {
        data = await response.json();
      } catch (e) {
        console.error("Failed to parse API response:", e);
        throw new Error("Invalid response from plan-feature API");
      }

      console.log("Raw API response data:", data);
      console.log("fieldTypes in response:", data.fieldTypes);

      if (!response.ok) {
        throw new Error(data.error || "Failed to generate schema");
      }

      // Validate API response has required fields
      if (!data.generatedDbml || !data.generatedDbmlWithBubbleTypes) {
        console.error("API response missing required fields:", {
          hasGeneratedDbml: !!data.generatedDbml,
          hasGeneratedDbmlWithBubbleTypes: !!data.generatedDbmlWithBubbleTypes
        });
        throw new Error("API response missing schema data");
      }

      // The API returns ONLY new tables for the feature (not existing tables)
      // Merge them with the original schema to create the full proposed schema
      const newTablesDbml = data.generatedDbml || '';
      const newTablesWithBubbleTypes = data.generatedDbmlWithBubbleTypes || '';
      const mergedDbml = (fetchState.data || '') + '\n\n' + newTablesDbml;
      const mergedBubbleTypesDbml = (fetchState.data || '') + '\n\n' + newTablesWithBubbleTypes;

      // Create diagram for proposed schema (using merged Bubble types version)
      const diagramResponse = await fetch("/api/diagram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dbml: mergedBubbleTypesDbml }),
      });

      if (!diagramResponse.ok) {
        throw new Error("Failed to create diagram for proposed schema");
      }

      const diagramData = await diagramResponse.json();

      // Analyze changes between current and proposed schema
      console.log("=== API RESPONSE ===");
      console.log("fieldTypes exists:", !!data.fieldTypes);
      console.log("fieldTypes:", data.fieldTypes);
      console.log("API returned (new tables only):", data.generatedDbml.substring(0, 200));
      console.log("Merged with original (full proposed):", mergedDbml.substring(0, 200));

      const changes = analyzeChanges(
        fetchState.data || "",
        mergedDbml,  // Compare against the merged full schema
        data.fieldTypes
      );
      console.log("=== CHANGES RESULT ===");
      console.log("newTables:", Object.keys(changes.newTables));
      console.log("newFields:", Object.keys(changes.newFields));

      setFetchState(prev => ({
        ...prev,
        successMessage: "Schema generated!",
        featurePlanning: {
          status: "success",
          description: featureDescription,
          featureTitle: data.featureTitle || featureDescription,
          originalDbml: fetchState.data,
          generatedDbml: mergedDbml,  // Store the full merged schema
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
      // Update chat context when switching views
      chatWithDb: prev.chatWithDb ? {
        ...prev.chatWithDb,
        currentSchemaContext: view,
      } : undefined,
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

  // Determine which schema the chat should reference based on current state
  // Returns "current" if no feature planning, or the activeView when planning is active
  const determineSchemaContext = (state: FetchState): "current" | "proposed" | null => {
    // No schema loaded yet
    if (!state.data) return null;

    // If feature planning is active, use the view they're currently looking at
    if (state.featurePlanning?.status === "success") {
      return state.featurePlanning.activeView || "current";
    }

    // Default to current schema
    return "current";
  };

  // Switch between "Plan a Feature" and "Chat with Database" tabs in the sidebar
  const handleTabChange = (tab: "plan-feature" | "chat-db" | "table-finder") => {
    setFetchState(prev => {
      // Initialize chat state if switching to chat for the first time
      if (tab === "chat-db" && !prev.chatWithDb) {
        return {
          ...prev,
          chatWithDb: {
            status: "idle",
            messages: [],
            currentSchemaContext: determineSchemaContext(prev),
            activeTab: tab,
          },
        };
      }

      // Initialize table finder state if switching to it for the first time
      if (tab === "table-finder" && !prev.tableFinder) {
        console.log("✓ Initializing table-finder tab");
        return {
          ...prev,
          chatWithDb: {
            ...(prev.chatWithDb || {
              status: "idle",
              messages: [],
              currentSchemaContext: null,
            }),
            activeTab: tab,
          },
          tableFinder: {
            status: "idle",
            messages: [],
            results: [],
          },
        };
      }

      // Just update active tab if chat or table finder already exists
      if (prev.chatWithDb) {
        if (tab === "table-finder") {
          console.log("✓ Switching to table-finder tab");
        }
        return {
          ...prev,
          chatWithDb: {
            ...prev.chatWithDb,
            activeTab: tab,
            currentSchemaContext: tab === "chat-db" ? determineSchemaContext(prev) : prev.chatWithDb.currentSchemaContext,
          },
        };
      }

      return prev;
    });
  };

  // Send a message to the chat API and get a response
  const handleSendMessage = async (message: string) => {
    if (!message.trim()) return;

    // Determine which schema to use for this chat
    const schemaContext = determineSchemaContext(fetchState);
    if (!schemaContext) {
      console.error("No schema available for chat");
      return;
    }

    // Get the DBML for the current schema context
    const dbmlToUse = schemaContext === "proposed"
      ? fetchState.featurePlanning!.generatedDbml!
      : fetchState.data!;

    // Create a user message object to add to the chat
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message.trim(),
      timestamp: Date.now(),
      schemaContext,
    };

    // Update state immediately with user message (for responsive UI)
    setFetchState(prev => ({
      ...prev,
      chatWithDb: {
        ...prev.chatWithDb!,
        status: "chatting",
        messages: [...prev.chatWithDb!.messages, userMessage],
      },
    }));

    try {
      // Prepare conversation history (last 6 messages = 3 exchanges) for context
      const conversationHistory = fetchState.chatWithDb!.messages
        .slice(-6)
        .map(msg => ({
          role: msg.role,
          content: msg.content,
        }));

      // Call the chat API endpoint
      const response = await fetch("/api/chat-db", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dbml: dbmlToUse,
          message: message.trim(),
          schemaType: schemaContext,
          conversationHistory,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to get response");
      }

      // Create assistant message to add to chat
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.response,
        timestamp: Date.now(),
        schemaContext,
      };

      // Update state with assistant's response
      setFetchState(prev => ({
        ...prev,
        chatWithDb: {
          ...prev.chatWithDb!,
          status: "idle",
          messages: [...prev.chatWithDb!.messages, assistantMessage],
          error: undefined,
        },
      }));
    } catch (error) {
      // Handle any errors that occur during the API call
      const errorMessage = error instanceof Error ? error.message : "An error occurred";

      setFetchState(prev => ({
        ...prev,
        chatWithDb: {
          ...prev.chatWithDb!,
          status: "error",
          error: errorMessage,
        },
      }));

      // Auto-clear error after 5 seconds
      setTimeout(() => {
        setFetchState(prev => ({
          ...prev,
          chatWithDb: prev.chatWithDb ? {
            ...prev.chatWithDb,
            status: "idle",
            error: undefined,
          } : undefined,
        }));
      }, 5000);
    }
  };

  // Handle table finder question - identify tables relevant to a feature and create table groups
  const handleTableFinderQuestion = async (question: string) => {
    if (!question.trim()) return;
    if (!fetchState.data) {
      console.error("No schema available for table finder");
      return;
    }

    console.log("↓ Table Finder: Asking question:", question.substring(0, 60) + "...");

    // Create a user message object
    const userMessage: TableFinderMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: question.trim(),
      timestamp: Date.now(),
    };

    // Update state immediately with user message
    setFetchState(prev => ({
      ...prev,
      tableFinder: {
        ...prev.tableFinder!,
        status: "searching",
        messages: [...prev.tableFinder!.messages, userMessage],
        error: undefined,
      },
    }));

    try {
      // Call the table finder API endpoint with the current DBML
      const response = await fetch("/api/table-finder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dbml: fetchState.data,
          question: question.trim(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to find tables");
      }

      // Call diagram API to generate embed URL for the updated DBML with table groups
      const diagramResponse = await fetch("/api/diagram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dbml: data.updatedDbml,
        }),
      });

      const diagramData = await diagramResponse.json();

      if (!diagramResponse.ok) {
        throw new Error(diagramData.error || "Failed to generate diagram");
      }

      // Create a new result for this question
      const resultId = `result-${Date.now()}`;
      const summary = generateSummaryFromQuestion(question.trim());
      const newResult = {
        id: resultId,
        question: question.trim(),
        summary,
        matchedTables: data.matchedTables,
        embedUrl: diagramData.embedUrl,
        dbml: data.updatedDbml,
        explanation: data.explanation,
      };

      // Create assistant message with explanation and matched tables
      const assistantMessage: TableFinderMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.explanation,
        timestamp: Date.now(),
        tableGroups: [data.tableGroupName],
        matchedTables: data.matchedTables,
      };

      // Update state with assistant response and new diagram
      setFetchState(prev => ({
        ...prev,
        chatWithDb: {
          ...(prev.chatWithDb || { status: "idle", messages: [], currentSchemaContext: null }),
          activeTab: "table-finder",
        },
        tableFinder: {
          ...(prev.tableFinder || { status: "idle", messages: [], results: [] }),
          status: "success" as const,
          messages: [...(prev.tableFinder?.messages || []), assistantMessage],
          results: [...(prev.tableFinder?.results || []), newResult],
          activeResultId: resultId,
          error: undefined,
        },
      }));
    } catch (error) {
      // Handle any errors that occur during the API call
      const errorMessage = error instanceof Error ? error.message : "An error occurred";

      setFetchState(prev => ({
        ...prev,
        tableFinder: {
          ...prev.tableFinder!,
          status: "error",
          error: errorMessage,
        },
      }));
    }
  };

  // Clear all messages from the chat and reset to idle state
  const handleClearChat = () => {
    setFetchState(prev => ({
      ...prev,
      chatWithDb: prev.chatWithDb ? {
        ...prev.chatWithDb,
        messages: [],
        status: "idle",
        error: undefined,
      } : undefined,
    }));
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
      let updatedDbmlWithBubbleTypes: string;
      try {
        updatedDbmlWithBubbleTypes = convertDbmlToBubbleTypes(updatedDbml);
        // Ensure no duplicates were introduced during type conversion
        updatedDbmlWithBubbleTypes = dedupDbml(updatedDbmlWithBubbleTypes);
      } catch (e) {
        console.error('Error converting DBML to Bubble types:', e);
        throw new Error(`Failed to convert DBML types: ${e instanceof Error ? e.message : String(e)}`);
      }

      console.log('📊 Generated DBML:');
      console.log('  Original length:', updatedDbml.length);
      console.log('  With Bubble types length:', updatedDbmlWithBubbleTypes.length);
      console.log('  Full content:');
      console.log(updatedDbml);
      console.log('  With Bubble types:');
      console.log(updatedDbmlWithBubbleTypes);

      // Log table count and names for debugging
      const tableCountMatches = updatedDbmlWithBubbleTypes.match(/^Table\s+/gm);
      console.log(`  Table count: ${tableCountMatches?.length || 0}`);

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
        // Try to parse as JSON, fall back to text if not JSON
        let errorMessage = 'Failed to generate diagram';
        const contentType = diagramResponse.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          try {
            const error = await diagramResponse.json();
            errorMessage = error.error || errorMessage;
          } catch {
            errorMessage = `Diagram API error: ${diagramResponse.status} ${diagramResponse.statusText}`;
          }
        } else {
          errorMessage = `Diagram API error: ${diagramResponse.status} ${diagramResponse.statusText}`;
        }
        throw new Error(errorMessage);
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
                    {/* Back Button and Tabs */}
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
                        {/* Feature Planning Tabs */}
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
                        {/* Table Finder Tabs */}
                        {fetchState.tableFinder?.status === "success" && (
                          <>
                            {fetchState.tableFinder.results.map((result) => (
                              <button
                                key={result.id}
                                onClick={() => setFetchState(prev => ({
                                  ...prev,
                                  tableFinder: prev.tableFinder ? {
                                    ...prev.tableFinder,
                                    activeResultId: result.id,
                                  } : undefined,
                                }))}
                                className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                                  fetchState.tableFinder?.activeResultId === result.id
                                    ? "bg-zinc-900 text-white"
                                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                                }`}
                              >
                                {result.summary}
                              </button>
                            ))}
                          </>
                        )}
                      </div>

                      {/* Plan Another / Find Tables Button - Top Right */}
                      {fetchState.featurePlanning?.status === "success" && (
                        <button
                          onClick={handlePlanFeature}
                          className="px-4 py-2 bg-zinc-900 text-white text-xs font-medium rounded-lg hover:bg-zinc-800 transition-colors flex-shrink-0"
                        >
                          + Plan Feature
                        </button>
                      )}
                      {fetchState.tableFinder?.status === "success" && (
                        <button
                          onClick={() => handleTabChange("table-finder")}
                          className="px-4 py-2 bg-zinc-900 text-white text-xs font-medium rounded-lg hover:bg-zinc-800 transition-colors flex-shrink-0"
                        >
                          + Find Tables
                        </button>
                      )}
                    </div>

                    {fetchState.iframeError ? (
                      <div className="flex-1 p-12 flex items-center justify-center">
                        <p className="text-zinc-600 text-sm">The diagram encountered an error while loading. This may be due to invalid database structure. Please try with a different app.</p>
                      </div>
                    ) : (
                      <>
                        {(() => {
                          const isTableFinderTab = fetchState.chatWithDb?.activeTab === "table-finder";
                          const hasSuccess = fetchState.tableFinder?.status === "success";
                          const hasActiveResult = !!fetchState.tableFinder?.activeResultId;
                          console.log("Main area condition check:", {
                            isTableFinderTab,
                            hasSuccess,
                            hasActiveResult,
                            activeTab: fetchState.chatWithDb?.activeTab,
                            tableFinder: fetchState.tableFinder,
                          });
                          return null;
                        })()}
                        {/* Show table finder diagram if table-finder tab is active and results exist */}
                        {fetchState.chatWithDb?.activeTab === "table-finder" && fetchState.tableFinder?.status === "success" && fetchState.tableFinder.activeResultId ? (
                          <>
                            {(() => {
                              const activeResult = fetchState.tableFinder?.results.find(r => r.id === fetchState.tableFinder?.activeResultId);
                              return activeResult ? (
                                <iframe
                                  key={activeResult.embedUrl}
                                  src={activeResult.embedUrl}
                                  className="w-full flex-1 border-0 rounded-[9px]"
                                  title="Table Groups Diagram"
                                  allow="fullscreen"
                                  sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                                  onLoad={() => console.log("Table-finder iframe loaded")}
                                  onError={() => console.error("Table-finder iframe error")}
                                />
                              ) : (
                                <div className="flex-1 p-12 flex items-center justify-center">
                                  <p className="text-zinc-600 text-sm">Result not found.</p>
                                </div>
                              );
                            })()}
                          </>
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
                                    allow="fullscreen"
                                    sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                                    onLoad={() => console.log("Proposed iframe loaded:", fetchState.featurePlanning?.proposedEmbedUrl)}
                                    onError={() => console.error("Proposed iframe failed to load:", fetchState.featurePlanning?.proposedEmbedUrl)}
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
                                    allow="fullscreen"
                                    sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                                    onLoad={() => console.log("Iframe loaded:", fetchState.embedUrl)}
                                    onError={() => {
                                      console.error("Iframe failed to load:", fetchState.embedUrl);
                                      setFetchState(prev => ({...prev, iframeError: true}));
                                    }}
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
                    {/* Tab Navigation - Show only if schema is loaded */}
                    {fetchState.status === "success" && (
                      <div className="flex gap-1 mb-3 border-b border-zinc-200">
                        <button
                          onClick={() => handleTabChange("plan-feature")}
                          className={`px-3 py-2 text-xs font-medium transition-colors ${
                            !fetchState.chatWithDb || fetchState.chatWithDb.activeTab === "plan-feature"
                              ? "border-b-2 border-zinc-900 text-zinc-900"
                              : "text-zinc-500 hover:text-zinc-700"
                          }`}
                        >
                          Plan Feature
                        </button>
                        <button
                          onClick={() => handleTabChange("chat-db")}
                          className={`px-3 py-2 text-xs font-medium transition-colors ${
                            fetchState.chatWithDb?.activeTab === "chat-db"
                              ? "border-b-2 border-zinc-900 text-zinc-900"
                              : "text-zinc-500 hover:text-zinc-700"
                          }`}
                        >
                          Chat with Database
                        </button>
                        <button
                          onClick={() => handleTabChange("table-finder")}
                          className={`px-3 py-2 text-xs font-medium transition-colors ${
                            fetchState.chatWithDb?.activeTab === "table-finder"
                              ? "border-b-2 border-zinc-900 text-zinc-900"
                              : "text-zinc-500 hover:text-zinc-700"
                          }`}
                        >
                          Table Finder
                        </button>
                      </div>
                    )}

                    {/* Feature Planning Tab Content */}
                    {(!fetchState.chatWithDb || fetchState.chatWithDb.activeTab === "plan-feature") && (
                      <>

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
                                // Step 0a: Generate full DBML that includes inline edits and original tables
                                // This is used later for the diagram
                                const currentDbmlWithInlineEdits = convertChangesToDbml(
                                  fetchState.featurePlanning?.originalDbml || '',
                                  fetchState.featurePlanning?.generatedDbml || '',
                                  fetchState.featurePlanning?.editedChanges!,
                                  fetchState.featurePlanning?.tableNameMap
                                );

                                // Step 0b: Generate proposal-only DBML (without original unmodified tables)
                                // This is sent to the edit-dbml API so Claude only edits the newly generated proposal
                                const proposalDbml = convertProposalToDbml(
                                  fetchState.featurePlanning?.generatedDbml || '',
                                  fetchState.featurePlanning?.editedChanges!,
                                  fetchState.featurePlanning?.tableNameMap
                                );
                                console.log('📝 Proposal DBML (newly generated tables only) sent to edit-dbml API:');
                                console.log(proposalDbml);

                                // Step 1: Get updated DBML from Claude
                                const editResponse = await fetch("/api/edit-dbml", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    currentDbml: proposalDbml,
                                    editInstruction: input.value,
                                  }),
                                });

                                if (!editResponse.ok) {
                                  throw new Error("Failed to process edit");
                                }

                                const editData = await editResponse.json();

                                // Step 2a: Merge the updated proposal with the original schema
                                // The API returned ONLY the updated proposal tables, so we need to merge with original
                                const mergedUpdatedDbml = (fetchState.featurePlanning?.originalDbml || '') + '\n\n' + editData.updatedDbml;
                                const mergedUpdatedBubbleTypesDbml = (fetchState.featurePlanning?.originalDbml || '') + '\n\n' + editData.updatedDbmlWithBubbleTypes;

                                // Step 2b: Generate new diagram with merged schema
                                const diagramResponse = await fetch("/api/diagram", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    dbml: mergedUpdatedBubbleTypesDbml,
                                  }),
                                });

                                let newEmbedUrl = "";
                                if (diagramResponse.ok) {
                                  const diagramData = await diagramResponse.json();
                                  newEmbedUrl = diagramData.embedUrl;
                                } else {
                                  // Fallback if diagram API fails
                                  newEmbedUrl = `https://dbdiagram.io/embed/${encodeURIComponent(mergedUpdatedBubbleTypesDbml)}`;
                                }

                                // Step 3: Analyze changes (compare against original schema)
                                const changes = analyzeChanges(
                                  fetchState.featurePlanning?.originalDbml || "",
                                  mergedUpdatedDbml,  // Compare against the merged full schema
                                  editData.fieldTypes
                                );

                                // Step 4: Generate TableGroup for feature tables
                                // Use convertChangesToDbml with the updated proposal (not merged) so it can generate TableGroup
                                // convertChangesToDbml will merge original + proposal and add TableGroup
                                const dbmlWithTableGroup = convertChangesToDbml(
                                  fetchState.featurePlanning?.originalDbml || '',
                                  editData.updatedDbml,  // Pass just the updated proposal, not merged
                                  changes,
                                  {}  // No table name map needed after Apply Edit
                                );

                                // Step 5: Update state
                                setFetchState(prev => {
                                  // Use the schema with TableGroup as the source of truth
                                  // It includes the original tables + updated proposal tables with proper grouping
                                  const editedChanges = JSON.parse(JSON.stringify(changes));

                                  console.log('✅ Applied API changes:', editedChanges);

                                  return {
                                    ...prev,
                                    successMessage: "Schema updated!",
                                    featurePlanning: {
                                      ...prev.featurePlanning!,
                                      generatedDbml: dbmlWithTableGroup,  // Store with TableGroup
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
                      </>
                    )}

                    {/* Chat with Database Tab Content */}
                    {fetchState.chatWithDb?.activeTab === "chat-db" && (
                      <div className="flex flex-col h-full">
                        {/* Empty State - Show when no messages */}
                        {fetchState.chatWithDb.messages.length === 0 ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3 py-6">
                            <div className="text-3xl">💬</div>
                            <h3 className="font-semibold text-sm text-zinc-900">Chat with your Database</h3>
                            <p className="text-xs text-zinc-600">Ask questions about your schema or request improvement suggestions</p>
                            <div className="w-full space-y-2 mt-4">
                              <button
                                onClick={() => handleSendMessage("What tables handle user authentication?")}
                                className="w-full text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 rounded px-2 py-2 transition-colors hover:bg-zinc-50"
                              >
                                What tables handle user authentication?
                              </button>
                              <button
                                onClick={() => handleSendMessage("Suggest improvements for this schema")}
                                className="w-full text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 rounded px-2 py-2 transition-colors hover:bg-zinc-50"
                              >
                                Suggest improvements for this schema
                              </button>
                              <button
                                onClick={() => handleSendMessage("Explain the relationships in this database")}
                                className="w-full text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 rounded px-2 py-2 transition-colors hover:bg-zinc-50"
                              >
                                Explain the relationships in this database
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {/* Message List */}
                            <div
                              id="chat-messages"
                              className="flex-1 overflow-y-auto space-y-2 mb-3 pr-2"
                            >
                              {fetchState.chatWithDb.messages.map((msg) => (
                                <div key={msg.id} className="space-y-1">
                                  {/* Schema Context Badge */}
                                  <div className="text-[10px] text-zinc-500">
                                    {msg.schemaContext === "current" ? "Current Schema" : "Proposed Schema"}
                                  </div>
                                  {/* Message Bubble */}
                                  <div
                                    className={`max-w-[85%] text-sm font-sans ${
                                      msg.role === "user"
                                        ? "ml-auto max-w-[80%] bg-blue-100 border border-blue-200 text-blue-900"
                                        : "mr-auto bg-white border border-zinc-200 text-zinc-900"
                                    } p-2 rounded-lg`}
                                  >
                                    {msg.role === "assistant" ? (
                                      <ReactMarkdown
                                        components={{
                                          h1: ({node, ...props}) => <h1 className="font-bold mb-3 mt-2" {...props} />,
                                          h2: ({node, ...props}) => <h2 className="font-bold mb-2 mt-2" {...props} />,
                                          h3: ({node, ...props}) => <h3 className="font-semibold mb-2" {...props} />,
                                          p: ({node, ...props}) => <p className="mb-3" {...props} />,
                                          ul: ({node, ...props}) => <ul className="ml-3 space-y-1 mb-3" {...props} />,
                                          ol: ({node, ...props}) => <ol className="ml-4 space-y-1 mb-3" {...props} />,
                                          li: ({node, ...props}) => <li style={{listStyleType: 'disc'}} {...props} />,
                                          code: ({node, children, ...props}: any) => <span {...props}>{children}</span>,
                                          blockquote: ({node, ...props}) => <blockquote className="border-l-2 pl-2 italic mb-3" {...props} />,
                                          strong: ({node, ...props}) => <strong className="font-semibold" {...props} />,
                                          em: ({node, ...props}) => <em className="italic" {...props} />,
                                          a: ({node, ...props}) => <a className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer" {...props} />,
                                          table: ({node, ...props}) => <table className="mb-3 w-full" {...props} />,
                                          tr: ({node, ...props}) => <tr className="border-b" {...props} />,
                                          th: ({node, ...props}) => <th className="text-left px-1 py-0.5 font-semibold" {...props} />,
                                          td: ({node, ...props}) => <td className="text-left px-1 py-0.5" {...props} />,
                                          hr: ({node, ...props}) => <hr className="my-3" {...props} />,
                                        }}
                                      >
                                        {msg.content}
                                      </ReactMarkdown>
                                    ) : (
                                      <div className="whitespace-pre-wrap">{msg.content}</div>
                                    )}
                                  </div>
                                </div>
                              ))}
                              {/* Loading State */}
                              {fetchState.chatWithDb.status === "chatting" && (
                                <div className="flex gap-2 items-center">
                                  <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                                  <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                                  <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                                </div>
                              )}
                            </div>
                          </>
                        )}

                        {/* Error Display */}
                        {fetchState.chatWithDb.error && (
                          <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                            {fetchState.chatWithDb.error}
                          </div>
                        )}

                        {/* Chat Input Area */}
                        <div className="border-t border-zinc-200 pt-2 space-y-2">
                          <textarea
                            placeholder="Ask about your schema or request suggestions..."
                            className="w-full p-2 border border-zinc-200 rounded text-xs resize-none focus:outline-none focus:ring-2 focus:ring-zinc-900"
                            rows={3}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                const textarea = e.currentTarget;
                                handleSendMessage(textarea.value);
                                textarea.value = "";
                              }
                            }}
                            id="chat-input"
                            disabled={fetchState.chatWithDb.status === "chatting"}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                const textarea = document.getElementById("chat-input") as HTMLTextAreaElement;
                                if (textarea) {
                                  handleSendMessage(textarea.value);
                                  textarea.value = "";
                                }
                              }}
                              disabled={fetchState.chatWithDb.status === "chatting"}
                              className="flex-1 px-3 py-1.5 bg-zinc-900 text-white text-xs font-medium rounded hover:bg-zinc-800 disabled:bg-gray-400 transition-colors"
                            >
                              Send
                            </button>
                            {fetchState.chatWithDb.messages.length > 0 && (
                              <button
                                onClick={handleClearChat}
                                className="px-2 py-1.5 border border-zinc-200 text-zinc-600 text-xs font-medium rounded hover:bg-zinc-50 transition-colors"
                                title="Clear chat history"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Table Finder Tab Content */}
                    {fetchState.chatWithDb?.activeTab === "table-finder" && (
                      <div className="flex flex-col h-full">
                        {/* Title / Header */}
                        <div className="mb-3 pb-2 border-b border-zinc-200">
                          <h3 className="font-semibold text-sm text-zinc-900">Find Related Tables</h3>
                          <p className="text-xs text-zinc-600 mt-1">Ask which tables are involved in a feature or workflow</p>
                        </div>

                        {/* Empty State - Show when no questions asked */}
                        {(!fetchState.tableFinder?.results || fetchState.tableFinder.results.length === 0) && (
                          <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3 py-6">
                            <div className="text-3xl">🔍</div>
                            <p className="text-xs text-zinc-600 px-2">Ask a question about your database to see related tables</p>
                            <div className="w-full space-y-2 mt-4">
                              <button
                                onClick={() => handleTableFinderQuestion("What tables are involved in user authentication?")}
                                className="w-full text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 rounded px-2 py-2 transition-colors hover:bg-zinc-50"
                              >
                                What tables are involved in user authentication?
                              </button>
                              <button
                                onClick={() => handleTableFinderQuestion("Show me tables related to billing")}
                                className="w-full text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 rounded px-2 py-2 transition-colors hover:bg-zinc-50"
                              >
                                Show me tables related to billing
                              </button>
                              <button
                                onClick={() => handleTableFinderQuestion("Which tables handle order processing?")}
                                className="w-full text-xs text-zinc-600 hover:text-zinc-900 border border-zinc-200 rounded px-2 py-2 transition-colors hover:bg-zinc-50"
                              >
                                Which tables handle order processing?
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Message History - Show previous questions */}
                        {fetchState.tableFinder?.messages.length !== 0 && (
                          <div className="mb-3 space-y-2 max-h-[200px] overflow-y-auto pr-2 border-t border-zinc-200 pt-2">
                            {fetchState.tableFinder?.messages.map((msg) => (
                              <div key={msg.id} className="space-y-1">
                                {/* Message Bubble */}
                                <div
                                  className={`text-sm font-sans ${
                                    msg.role === "user"
                                      ? "ml-auto max-w-[80%] bg-blue-100 border border-blue-200 text-blue-900"
                                      : "mr-auto bg-white border border-zinc-200 text-zinc-900"
                                  } p-2 rounded-lg`}
                                >
                                  {msg.content}
                                </div>
                                {/* Matched Tables Display */}
                                {msg.matchedTables && msg.matchedTables.length > 0 && (
                                  <div className="mr-auto max-w-[80%] text-xs space-y-1">
                                    <div className="text-zinc-600 font-medium">Tables found:</div>
                                    <div className="flex flex-wrap gap-1">
                                      {msg.matchedTables.map((table) => (
                                        <span
                                          key={table}
                                          className="inline-block bg-amber-100 text-amber-900 px-2 py-1 rounded text-xs"
                                        >
                                          {table}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                            {/* Loading State */}
                            {fetchState.tableFinder?.status === "searching" && (
                              <div className="flex gap-2 items-center">
                                <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                                <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                                <div className="w-2 h-2 bg-zinc-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Error Display */}
                        {fetchState.tableFinder?.error && (
                          <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                            {fetchState.tableFinder.error}
                          </div>
                        )}

                        {/* Table Finder Input Area */}
                        <div className="border-t border-zinc-200 pt-2 space-y-2">
                          <textarea
                            placeholder="Ask which tables are involved in a feature or workflow..."
                            className="w-full p-2 border border-zinc-200 rounded text-xs resize-none focus:outline-none focus:ring-2 focus:ring-zinc-900"
                            rows={3}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                const textarea = e.currentTarget;
                                handleTableFinderQuestion(textarea.value);
                                textarea.value = "";
                              }
                            }}
                            id="table-finder-input"
                            disabled={fetchState.tableFinder?.status === "searching"}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                const textarea = document.getElementById("table-finder-input") as HTMLTextAreaElement;
                                if (textarea) {
                                  handleTableFinderQuestion(textarea.value);
                                  textarea.value = "";
                                }
                              }}
                              disabled={fetchState.tableFinder?.status === "searching"}
                              className="flex-1 px-3 py-1.5 bg-zinc-900 text-white text-xs font-medium rounded hover:bg-zinc-800 disabled:bg-gray-400 transition-colors"
                            >
                              Search Tables
                            </button>
                            {fetchState.tableFinder?.messages.length !== 0 && (
                              <button
                                onClick={() => {
                                  setFetchState(prev => ({
                                    ...prev,
                                    tableFinder: prev.tableFinder ? {
                                      ...prev.tableFinder,
                                      messages: [],
                                      status: "idle",
                                      error: undefined,
                                      currentDbml: undefined,
                                      currentEmbedUrl: undefined,
                                    } : undefined,
                                  }));
                                }}
                                className="px-2 py-1.5 border border-zinc-200 text-zinc-600 text-xs font-medium rounded hover:bg-zinc-50 transition-colors"
                                title="Clear search history"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </div>
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
