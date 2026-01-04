import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { dbml } = await request.json();

    if (!dbml) {
      return NextResponse.json(
        { error: "DBML content is required" },
        { status: 400 }
      );
    }

    const token = process.env.DBDIAGRAM_API_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: "dbDiagram API token not configured" },
        { status: 500 }
      );
    }

    // Create diagram
    console.log("=== CREATING DBDIAGRAM ===");
    console.log("DBML length:", dbml.length);
    console.log("First 200 chars:", dbml.substring(0, 200));
    
    const diagramResponse = await fetch("https://api.dbdiagram.io/v1/diagrams", {
      method: "POST",
      headers: {
        "dbdiagram-access-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Database Schema Diagram",
        content: dbml,
      }),
    });

    if (!diagramResponse.ok) {
      const errorData = await diagramResponse.text();
      console.error("dbDiagram API error - status:", diagramResponse.status);
      console.error("dbDiagram API error - response:", errorData);
      throw new Error(
        `dbDiagram API error: ${diagramResponse.status} ${errorData.substring(0, 500)}`
      );
    }

    const diagramData = await diagramResponse.json();
    const diagramId = diagramData.id;

    // Create embed link
    const embedResponse = await fetch(
      `https://api.dbdiagram.io/v1/embed_link/${diagramId}`,
      {
        method: "POST",
        headers: {
          "dbdiagram-access-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          detailLevel: "All",
          darkMode: "true",
          highlight: "false",
          enabled: "true",
        }),
      }
    );

    if (!embedResponse.ok) {
      const errorData = await embedResponse.text();
      throw new Error(
        `dbDiagram embed API error: ${embedResponse.status} ${errorData}`
      );
    }

    const embedData = await embedResponse.json();

    return NextResponse.json({
      diagramId: diagramId,
      embedUrl: embedData.url,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
