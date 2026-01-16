/**
 * PDF Export API Endpoint
 *
 * PURPOSE:
 * This endpoint generates a downloadable PDF file from a database diagram.
 * Users can export their schema visualization to share with team members
 * or include in documentation.
 *
 * WHAT IT DOES:
 * 1. Receives the URL of a dbDiagram embed
 * 2. Opens the URL in a headless browser (invisible browser running on server)
 * 3. Waits for the diagram to fully render
 * 4. Captures the page as a PDF document
 * 5. Returns the PDF as a downloadable file
 *
 * WHY PUPPETEER:
 * dbDiagram renders diagrams using JavaScript/SVG in the browser. To capture
 * this as a PDF, we need an actual browser to render the page. Puppeteer is
 * a tool that lets us control a Chrome browser programmatically.
 *
 * INPUT: JSON body with "diagramUrl" field containing the dbDiagram embed URL
 * OUTPUT: PDF file download (application/pdf)
 * ERRORS: Returns error if browser fails or diagram doesn't load
 */

import { NextRequest, NextResponse } from "next/server";
import puppeteer from "puppeteer";

/**
 * Main Request Handler
 *
 * Uses Puppeteer (headless Chrome) to:
 * 1. Navigate to the diagram URL
 * 2. Wait for the SVG diagram to render
 * 3. Capture the page as a high-quality PDF
 * 4. Return the PDF as a file download
 */
export async function POST(request: NextRequest) {
  let browser;

  try {
    const { diagramUrl } = await request.json();

    if (!diagramUrl) {
      return NextResponse.json(
        { error: "Diagram URL is required" },
        { status: 400 }
      );
    }

    // STEP 1: Launch a headless Chrome browser
    // "headless: true" means no visible browser window - it runs in the background
    // The args disable security sandboxing which is needed for server environments
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // Create a new browser tab
    const page = await browser.newPage();

    // STEP 2: Set a large viewport for high-quality capture
    // Using 2560x1440 (2K resolution) ensures the diagram looks crisp
    await page.setViewport({ width: 2560, height: 1440 });

    // STEP 3: Navigate to the diagram URL and wait for it to load
    // "networkidle2" means wait until network activity settles down
    await page.goto(diagramUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // STEP 4: Wait for the SVG diagram element to appear
    // dbDiagram renders its diagrams as SVG graphics
    await page.waitForSelector("svg", { timeout: 20000 }).catch(() => {
      // If no SVG found after 20 seconds, continue anyway (might be a different format)
    });

    // STEP 5: Give extra time for any animations or lazy rendering to complete
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 3000)));

    // STEP 6: Zoom out slightly to fit more of the diagram on the page
    await page.evaluate(() => {
      document.body.style.zoom = "75%";
    });

    // Brief pause after zoom for layout to adjust
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));

    // STEP 7: Generate the PDF with professional formatting
    const pdf = await page.pdf({
      format: "A4",           // Standard paper size
      landscape: true,        // Horizontal orientation (better for wide diagrams)
      margin: { top: 10, right: 10, bottom: 10, left: 10 }, // Minimal margins
      printBackground: true,  // Include background colors
      scale: 1.2,            // Slight enlargement for readability
    });

    // STEP 8: Clean up - close the browser to free resources
    await browser.close();

    // STEP 9: Return the PDF as a downloadable file
    // The Content-Disposition header triggers a file download in the browser
    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="database-diagram.pdf"',
      },
    });
  } catch (error) {
    if (browser) {
      await browser.close();
    }

    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";

    return NextResponse.json(
      { error: `Failed to generate PDF: ${errorMessage}` },
      { status: 500 }
    );
  }
}
