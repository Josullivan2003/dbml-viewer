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

  const tableMatches = dbml.matchAll(/Table\s+"?(\w+)"?\s*\{([^}]*)\}/g);

  for (const match of tableMatches) {
    const tableName = match[1];
    const tableBody = match[2];
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
      const fieldType = fieldMatch[2].trim();
      const constraints = fieldMatch[3] || "";

      // Skip if not a valid field
      if (!fieldName || !fieldType || fieldName === "Note") continue;

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
  console.log("bubbleFieldTypes param exists:", !!bubbleFieldTypes);
  console.log("bubbleFieldTypes:", JSON.stringify(bubbleFieldTypes, null, 2));
  console.log("Available tables in bubbleFieldTypes:", Object.keys(bubbleFieldTypes || {}));

  // Find new tables and new fields in existing tables
  for (const [tableName, fields] of Object.entries(proposed.tables)) {
    if (!current.tables[tableName]) {
      // This is a new table - add descriptions from DBML notes
      console.log(`Processing new table: ${tableName}`);
      console.log(`  bubbleFieldTypes[${tableName}]:`, bubbleFieldTypes?.[tableName]);
      const fieldsWithDescriptions = fields.map(field => {
        console.log(`  Field ${tableName}.${field.name}: type="${field.type}"`);
        return {
          ...field,
          description: proposed.fieldNotes[tableName]?.[field.name],
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
      const added = fields.filter(f => !currentFieldNames.has(f.name));
      if (added.length > 0) {
        const fieldsWithDescriptions = added.map(field => {
          console.log(`New field in ${tableName}.${field.name}: type="${field.type}"`);
          return {
            ...field,
            description: proposed.fieldNotes[tableName]?.[field.name],
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
  featurePlanning?: {
    status: "idle" | "planning" | "generating" | "success" | "error";
    description?: string;
    featureTitle?: string;
    generatedDbml?: string;
    proposedEmbedUrl?: string;
    error?: string;
    activeView?: "current" | "proposed";
    changes?: SchemaChange;
  };
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
        status: "planning",
        activeView: "current",
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
        featurePlanning: {
          status: "success",
          description: featureDescription,
          featureTitle: data.featureTitle || featureDescription,
          generatedDbml: data.generatedDbml,
          proposedEmbedUrl: diagramData.embedUrl,
          activeView: "proposed",
          changes,
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

        {/* Toast Notification */}
        {fetchState.status === "error" && (
          <div className="fixed top-4 right-4 bg-red-500 text-white px-6 py-4 rounded-lg shadow-lg max-w-sm z-50 toast-enter">
            <p className="text-sm font-medium">{fetchState.error}</p>
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
                    <div className="flex gap-2 mb-3 w-fit items-center">
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
                      <div className="flex-1 flex flex-col justify-between">
                        <div className="space-y-3">
                          <p className="text-sm text-zinc-700 leading-relaxed">Let our AI plan new features and restructure your database</p>
                          <button
                            onClick={handlePlanFeature}
                            className="w-full px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors"
                          >
                            Plan a Feature
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {/* Planning State */}
                    {fetchState.featurePlanning?.status === "planning" && (
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
                        <button
                          onClick={handleClosePlanning}
                          className="w-full px-4 py-2 bg-zinc-100 text-zinc-700 text-sm font-medium rounded-lg hover:bg-zinc-200 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

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
                        <div className="bg-green-50 border border-green-200 rounded p-3">
                          <p className="text-xs text-green-800 font-medium">✓ Schema generated!</p>
                        </div>

                        {/* Changes Summary */}
                        {fetchState.featurePlanning!.changes && (Object.keys(fetchState.featurePlanning!.changes.newTables).length > 0 || Object.keys(fetchState.featurePlanning!.changes.newFields).length > 0) && (
                          <div className="bg-orange-50 border border-orange-200 rounded-lg p-2.5 space-y-2">
                            <p className="text-xs font-bold text-orange-900 px-1">Schema Changes</p>

                            {Object.keys(fetchState.featurePlanning!.changes!.newTables).length > 0 && (
                              <div className="space-y-1">
                                <p className="text-xs font-semibold text-orange-800 px-1">New Tables</p>
                                {Object.entries(fetchState.featurePlanning!.changes!.newTables).map(([tableName, fields]) => (
                                  <div key={tableName} className="bg-white border border-orange-200 rounded overflow-hidden">
                                    <button
                                      onClick={() => toggleSchemaTable(tableName)}
                                      className="w-full px-2 py-1 bg-orange-100 border-b border-orange-200 hover:bg-orange-150 transition-colors flex items-start gap-2 text-left"
                                    >
                                      <span className="text-orange-700 font-semibold text-xs mt-0.5 min-w-3">
                                        {isSchemaTableExpanded(tableName) ? "▼" : "►"}
                                      </span>
                                      <div className="flex-1">
                                        <p className="text-xs font-bold text-orange-900">{tableName}</p>
                                        {fetchState.featurePlanning!.changes!.tableDescriptions?.[tableName] && (
                                          <p className="text-xs text-orange-700 italic mt-0.5 leading-tight">{fetchState.featurePlanning!.changes!.tableDescriptions[tableName]}</p>
                                        )}
                                      </div>
                                    </button>
                                    {isSchemaTableExpanded(tableName) && (
                                      <table className="w-full text-xs border-collapse">
                                        <thead>
                                          <tr className="border-b border-orange-300 bg-orange-50">
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Column</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-1/5">Type</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Description</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {fields.map((field) => (
                                            <tr key={`${tableName}-${field.name}`} className="border-b border-orange-100 hover:bg-orange-50 transition-colors">
                                              <td className="px-2 py-1 font-semibold text-orange-800 break-words text-xs">{field.name}</td>
                                              <td className="px-2 py-1 text-orange-700 break-words text-xs">{field.type}</td>
                                              <td className="px-2 py-1 text-orange-600 italic break-words text-xs line-clamp-2">{field.description || "-"}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}

                            {Object.keys(fetchState.featurePlanning!.changes!.newFields).length > 0 && (
                              <div className="space-y-1 pt-1">
                                <p className="text-xs font-semibold text-orange-800 px-1">Modified Tables</p>
                                {Object.entries(fetchState.featurePlanning!.changes!.newFields).map(([tableName, fields]) => (
                                  <div key={tableName} className="bg-white border border-orange-200 rounded overflow-hidden">
                                    <button
                                      onClick={() => toggleSchemaTable(tableName)}
                                      className="w-full px-2 py-1 bg-orange-100 border-b border-orange-200 hover:bg-orange-150 transition-colors flex items-start gap-2 text-left"
                                    >
                                      <span className="text-orange-700 font-semibold text-xs mt-0.5 min-w-3">
                                        {isSchemaTableExpanded(tableName) ? "▼" : "►"}
                                      </span>
                                      <div className="flex-1">
                                        <p className="text-xs font-bold text-orange-900">{tableName}</p>
                                        {fetchState.featurePlanning!.changes!.tableDescriptions?.[tableName] && (
                                          <p className="text-xs text-orange-700 italic mt-0.5 leading-tight">{fetchState.featurePlanning!.changes!.tableDescriptions[tableName]}</p>
                                        )}
                                      </div>
                                    </button>
                                    {isSchemaTableExpanded(tableName) && (
                                      <table className="w-full text-xs border-collapse">
                                        <thead>
                                          <tr className="border-b border-orange-300 bg-orange-50">
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Column</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-1/5">Type</th>
                                            <th className="text-left px-2 py-1 font-bold text-orange-900 text-xs w-2/5">Description</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {fields.map((field) => (
                                            <tr key={`${tableName}-${field.name}`} className="border-b border-orange-100 hover:bg-orange-50 transition-colors">
                                              <td className="px-2 py-1 font-semibold text-orange-800 break-words text-xs">{field.name}</td>
                                              <td className="px-2 py-1 text-orange-700 break-words text-xs">{field.type}</td>
                                              <td className="px-2 py-1 text-orange-600 italic break-words text-xs line-clamp-2">{field.description || "-"}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        <button
                          onClick={handlePlanFeature}
                          className="w-full px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors"
                        >
                          Plan Another
                        </button>

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

                                // Step 3: Analyze changes
                                const changes = analyzeChanges(
                                  fetchState.featurePlanning?.generatedDbml || "",
                                  editData.updatedDbml,
                                  editData.fieldTypes
                                );

                                // Step 4: Update state
                                setFetchState(prev => ({
                                  ...prev,
                                  featurePlanning: {
                                    ...prev.featurePlanning!,
                                    generatedDbml: editData.updatedDbml,
                                    proposedEmbedUrl: newEmbedUrl,
                                    changes,
                                  },
                                }));

                                input.value = "";
                                alert("Schema updated!");
                              } catch (error) {
                                alert("Error: " + (error instanceof Error ? error.message : "Unknown error"));
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
