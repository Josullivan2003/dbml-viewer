import { NextRequest, NextResponse } from "next/server";
import puppeteer from "puppeteer";

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

    // Launch Puppeteer browser
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // Set high resolution viewport
    await page.setViewport({ width: 2560, height: 1440 });

    // Navigate to the diagram URL
    await page.goto(diagramUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for SVG to be rendered
    await page.waitForSelector("svg", { timeout: 20000 }).catch(() => {
      // Continue even if no SVG found
    });

    // Wait for rendering to complete
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 3000)));

    // Zoom out to fit entire diagram, then generate PDF
    await page.evaluate(() => {
      // Try to zoom out to see the full diagram
      document.body.style.zoom = "75%";
    });

    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));

    // Generate high-quality PDF
    const pdf = await page.pdf({
      format: "A4",
      landscape: true,
      margin: { top: 10, right: 10, bottom: 10, left: 10 },
      printBackground: true,
      scale: 1.2,
    });

    // Close browser
    await browser.close();

    // Return PDF as file download
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
