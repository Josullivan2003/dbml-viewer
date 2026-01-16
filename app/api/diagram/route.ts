/**
 * Diagram Generation API Endpoint
 *
 * PURPOSE:
 * This endpoint takes DBML (Database Markup Language) content and creates a visual
 * diagram that can be displayed in the app using an iframe.
 *
 * WHAT IT DOES:
 * 1. Receives DBML content describing database tables and their relationships
 * 2. Sends the DBML to dbDiagram.io's API to create a diagram
 * 3. Requests an embeddable link for that diagram
 * 4. Returns both the diagram ID and the embed URL
 *
 * WHY THIS MATTERS:
 * dbDiagram.io is a service that turns DBML text into beautiful visual diagrams.
 * By using their API, we can show users a professional visualization of their
 * database schema without building diagram rendering ourselves.
 *
 * INPUT: JSON body with "dbml" field containing the schema text
 * OUTPUT: JSON with "diagramId" and "embedUrl" for displaying the diagram
 * ERRORS: Returns error if DBML is invalid or API calls fail
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { dbml } = await request.json();

    // Validate that we received DBML content to create a diagram from
    if (!dbml) {
      return NextResponse.json(
        { error: "DBML content is required" },
        { status: 400 }
      );
    }

    // Check that the API token is configured - this is set in the environment variables
    const token = process.env.DBDIAGRAM_API_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: "dbDiagram API token not configured" },
        { status: 500 }
      );
    }

    // STEP 1: Create a new diagram on dbDiagram.io
    // This sends our DBML content to their servers and they generate a diagram from it
    console.log("=== CREATING DBDIAGRAM ===");
    console.log("DBML length:", dbml.length);
    console.log("First 200 chars:", dbml.substring(0, 200));
    console.log("Last 400 chars:", dbml.slice(-400));
    console.log("Contains TableGroup:", dbml.includes("TableGroup"));

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

    // Handle errors from the diagram creation API
    if (!diagramResponse.ok) {
      const errorData = await diagramResponse.text();
      console.error("dbDiagram API error - status:", diagramResponse.status);
      console.error("dbDiagram API error - response:", errorData);
      throw new Error(
        `dbDiagram API error: ${diagramResponse.status} ${errorData.substring(0, 500)}`
      );
    }

    // Extract the diagram ID from the response - we need this to get an embed link
    const diagramData = await diagramResponse.json();
    const diagramId = diagramData.id;

    // STEP 2: Create an embeddable link for the diagram
    // This gives us a URL we can use in an iframe to display the diagram
    // We configure it with dark mode and full detail level for better visibility
    const embedResponse = await fetch(
      `https://api.dbdiagram.io/v1/embed_link/${diagramId}`,
      {
        method: "POST",
        headers: {
          "dbdiagram-access-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          detailLevel: "All",      // Show all fields and relationships
          darkMode: "true",        // Use dark theme for better visibility
          highlight: "false",      // Don't highlight specific tables
          enabled: "true",         // Enable the embed link
        }),
      }
    );

    // Handle errors from the embed link creation API
    if (!embedResponse.ok) {
      const errorData = await embedResponse.text();
      throw new Error(
        `dbDiagram embed API error: ${embedResponse.status} ${errorData}`
      );
    }

    const embedData = await embedResponse.json();

    // Return the diagram ID and embed URL for the frontend to use
    return NextResponse.json({
      diagramId: diagramId,
      embedUrl: embedData.url,
    });
  } catch (error) {
    // Handle any unexpected errors during diagram generation
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
