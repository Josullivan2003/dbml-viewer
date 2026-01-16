/**
 * Schema Analysis API Endpoint
 *
 * PURPOSE:
 * This endpoint analyzes a database schema to identify potential performance and
 * scalability issues. It acts like a database consultant, reviewing the schema
 * and pointing out problems before they cause issues in production.
 *
 * WHAT IT DOES:
 * 1. Receives the current DBML schema
 * 2. Sends it to Claude AI for expert analysis
 * 3. Claude identifies structural issues like:
 *    - Tables with too many fields (slow queries)
 *    - Deep relationship chains (slow lookups)
 *    - Missing back-references (inefficient queries)
 *    - Duplicated data (wasted storage, sync issues)
 *    - Similar tables that could be consolidated
 * 4. Returns scored issues with recommendations
 *
 * WHY THIS MATTERS:
 * Database design problems often don't become apparent until the app has lots of
 * users and data. By analyzing the schema upfront, users can fix issues before
 * they cause performance problems.
 *
 * INPUT: JSON body with "dbml" field containing the schema to analyze
 * OUTPUT: JSON with performance/scalability scores and list of issues
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Issue Severity Levels
 *
 * - warning: High impact - will likely cause noticeable performance problems
 * - suggestion: Medium impact - could cause issues as the app grows
 * - info: Low impact - optimization opportunity but not critical
 */
type IssueSeverity = "warning" | "suggestion" | "info";

/**
 * Issue Categories
 *
 * Each category represents a specific type of database design problem:
 * - missing-normalization: Repeated column groups that should be a separate table
 * - over-normalization: Too many small tables requiring excessive joins
 * - missing-denormalization: Frequently accessed data requiring multiple lookups
 * - wide-table: Tables with too many columns that should be split
 * - unbounded-growth: Tables that will grow indefinitely without partitioning
 */
type IssueCategory =
  | "missing-normalization"
  | "over-normalization"
  | "missing-denormalization"
  | "wide-table"
  | "unbounded-growth";

/**
 * Schema Issue Structure
 *
 * Represents a single problem found in the schema, with all the information
 * needed to understand and fix it.
 */
interface SchemaIssue {
  id: string;                    // Unique identifier for React keys
  category: IssueCategory;       // Type of problem
  severity: IssueSeverity;       // How serious the problem is
  title: string;                 // Short summary (e.g., "Wide Table: user")
  description: string;           // Detailed explanation of the problem
  affectedTables: string[];      // Which tables have this issue
  affectedFields?: string[];     // Which specific fields (if applicable)
  recommendation: string;        // How to fix the problem
}

// Builds the system prompt that instructs Claude to analyze the schema for structural issues
// Claude acts as a database architecture reviewer, returning structured JSON with identified problems
function buildSystemPrompt(): string {
  return `You are a database performance analyst reviewing a Bubble.io database schema in DBML format. Your goal is to identify issues that could negatively impact the app's PERFORMANCE and SCALABILITY, and provide overall scores.

YOUR TASK:
1. Analyze the schema for structural issues that affect app performance and scalability
2. Provide overall PERFORMANCE score out of 100

PRIORITY: Breaking down large tables into smaller, focused tables is the most impactful optimization. Prioritize identifying wide tables and missing normalization issues above all else.

ISSUE CATEGORIES TO CHECK:

SCHEMA DESIGN PATTERNS:

1. MISSING NORMALIZATION (severity: "warning", category: "missing-normalization")
   - Look for repeated column groups across tables that suggest a separate table should be created
   - Example: address_line1, address_line2, address_city, address_zip appearing in multiple tables
   - Example: multiple similar fields like contact1_name, contact1_email, contact2_name, contact2_email
   - These patterns indicate data that should be in its own table with a relationship

2. OVER-NORMALIZATION (severity: "suggestion", category: "over-normalization")
   - Too many small tables that require excessive joins for common operations
   - Data that is almost always accessed together but split across multiple tables
   - Example: user_profile, user_settings, user_preferences all with 1:1 relationships to user
   - This creates unnecessary complexity and slows down reads

3. MISSING DENORMALIZATION (severity: "info", category: "missing-denormalization")
   - Frequently accessed data requiring multiple lookups that could be cached/duplicated
   - Example: displaying a user's name alongside every order requires joining to user table each time
   - For read-heavy patterns, strategic denormalization improves performance

TABLE STRUCTURE:

4. WIDE TABLE (severity: "warning", category: "wide-table")
   - Tables with more than 20 fields that would benefit from vertical partitioning
   - Look for logical groupings of fields that could be split into related tables
   - Example: a user table with profile fields, billing fields, preferences, and stats all together
   - Wide tables slow down every query even when only a few fields are needed

5. UNBOUNDED GROWTH (severity: "warning", category: "unbounded-growth")
   - Tables likely to grow very large without an obvious partitioning or archiving strategy
   - Look for: logs, events, messages, notifications, transactions, history tables
   - These tables accumulate data indefinitely and will eventually cause performance issues
   - Recommend time-based partitioning or archiving strategies

SCORING GUIDELINES:

PERFORMANCE SCORE (0-100): Overall database health combining query speed and growth readiness
- 90-100: Excellent - your database is well-optimized, queries run fast
- 70-89: Good - minor issues that may cause occasional slowdowns
- 50-69: Fair - noticeable issues affecting user experience
- 30-49: Poor - significant issues causing slow page loads
- 0-29: Critical - major issues, app likely experiencing timeouts

Deduct points based on issues found:
- Each "warning" severity issue: -10 to -20 points (depending on impact)
- Each "suggestion" severity issue: -5 to -10 points
- Each "info" severity issue: -2 to -5 points

RULES:
1. Return ONLY valid JSON - no markdown code blocks, no explanations outside JSON
2. Be specific about which tables and fields are affected
3. Frame ALL descriptions and recommendations in terms of PERFORMANCE and SCALABILITY impact
4. Only report genuine issues - do not invent problems that don't exist
5. If no issues are found in a category, simply don't include issues for that category
6. Be conservative - only flag issues you're confident about
7. IMPORTANT: Limit to the TOP 10 most important issues maximum. Prioritize by performance impact.
8. Keep recommendations concise (1-2 sentences) and focused on performance benefits
9. For affectedFields, list at most 10 fields - use "..." if there are more
10. ALWAYS include scores even if there are no issues (scores would be 95-100 in that case)
11. ORDER issues by severity: "warning" issues first, then "suggestion", then "info"

OUTPUT FORMAT (return ONLY this JSON structure):
{
  "performance": 75,
  "issues": [
    {
      "category": "table-width",
      "severity": "warning",
      "title": "Wide Table: tablename",
      "description": "Performance impact explanation - how this slows down the app",
      "affectedTables": ["tablename"],
      "affectedFields": ["field1", "field2"],
      "recommendation": "How to fix this to improve performance and scalability"
    }
  ]
}

If no issues are found, return: {"performance": 98, "issues": []}`;
}

// Validates basic DBML structure - checks for tables and balanced braces
function validateDbml(dbml: string): { valid: boolean; error?: string } {
  if (!dbml.includes("Table ")) {
    return { valid: false, error: "No tables defined" };
  }

  const openBraces = (dbml.match(/\{/g) || []).length;
  const closeBraces = (dbml.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    return { valid: false, error: "Mismatched braces" };
  }

  return { valid: true };
}

export async function POST(request: NextRequest) {
  try {
    const { dbml } = await request.json();

    // Validate required input - we need the DBML schema to analyze
    if (!dbml) {
      return NextResponse.json(
        { error: "DBML schema is required" },
        { status: 400 }
      );
    }

    // Validate input DBML has tables before sending to Claude
    const validation = validateDbml(dbml);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Invalid input DBML: ${validation.error}` },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key not configured" },
        { status: 500 }
      );
    }

    // Call Claude API to analyze the schema for structural issues
    // Using Haiku model for cost efficiency since this is a structured analysis task
    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192, // Increased to handle large schemas with many issues
      temperature: 0.2, // Lower temperature for more consistent, focused analysis
      system: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: `Analyze this database schema for structural issues:\n\n${dbml}`,
        },
      ],
    });

    // Check if the response was truncated due to max tokens
    if (message.stop_reason === "max_tokens") {
      console.warn("Schema analysis response was truncated due to max tokens");
    }

    // Extract response text from Claude's response
    let responseText =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!responseText) {
      return NextResponse.json(
        { error: "No response from AI" },
        { status: 500 }
      );
    }

    // Clean up markdown code blocks if Claude included them despite instructions
    responseText = responseText.trim();
    if (responseText.startsWith("```")) {
      responseText = responseText
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
    }
    responseText = responseText.trim();

    // Parse the JSON response from Claude
    // If the response was truncated, try to repair it by closing incomplete structures
    let analysisResult: {
      performance?: number;
      issues: Omit<SchemaIssue, "id">[]
    };
    try {
      analysisResult = JSON.parse(responseText);
    } catch (parseError) {
      console.warn("Initial JSON parse failed, attempting to repair truncated response...");

      // Try to repair truncated JSON by finding the last complete issue
      // Look for the last complete issue object (ends with })
      const lastCompleteIssueMatch = responseText.match(/^([\s\S]*\})\s*,?\s*\{[^}]*$/);
      if (lastCompleteIssueMatch) {
        // Try closing the array and object
        const repairedJson = lastCompleteIssueMatch[1] + "]}";
        try {
          analysisResult = JSON.parse(repairedJson);
          console.log("Successfully repaired truncated JSON response");
        } catch {
          // If repair failed, try a more aggressive approach
          // Find all complete issue objects
          const issuesMatch = responseText.match(/"issues"\s*:\s*\[([\s\S]*)/);
          if (issuesMatch) {
            const issuesContent = issuesMatch[1];
            // Find the last closing brace that completes an issue
            let lastValidIndex = -1;
            let braceCount = 0;
            let inString = false;
            let escapeNext = false;

            for (let i = 0; i < issuesContent.length; i++) {
              const char = issuesContent[i];
              if (escapeNext) {
                escapeNext = false;
                continue;
              }
              if (char === '\\') {
                escapeNext = true;
                continue;
              }
              if (char === '"') {
                inString = !inString;
                continue;
              }
              if (inString) continue;

              if (char === '{') braceCount++;
              if (char === '}') {
                braceCount--;
                if (braceCount === 0) {
                  lastValidIndex = i;
                }
              }
            }

            if (lastValidIndex > 0) {
              const validIssuesContent = issuesContent.substring(0, lastValidIndex + 1);
              const repairedJson2 = `{"issues": [${validIssuesContent}]}`;
              try {
                analysisResult = JSON.parse(repairedJson2);
                console.log("Successfully repaired truncated JSON with partial issues");
              } catch {
                console.error("Failed to repair truncated JSON:", responseText.substring(0, 500));
                return NextResponse.json(
                  { error: "Analysis response was truncated. Please try again." },
                  { status: 500 }
                );
              }
            } else {
              console.error("Could not find any complete issues in response");
              return NextResponse.json(
                { error: "Analysis response was truncated. Please try again." },
                { status: 500 }
              );
            }
          } else {
            console.error("Failed to parse Claude response:", responseText.substring(0, 500));
            return NextResponse.json(
              { error: "Failed to parse analysis results" },
              { status: 500 }
            );
          }
        }
      } else {
        // Try simpler repair - just close the JSON
        try {
          // Check if we just need to close brackets
          const openBraces = (responseText.match(/\{/g) || []).length;
          const closeBraces = (responseText.match(/\}/g) || []).length;
          const openBrackets = (responseText.match(/\[/g) || []).length;
          const closeBrackets = (responseText.match(/\]/g) || []).length;

          let repaired = responseText;
          // Remove any trailing incomplete string or field
          repaired = repaired.replace(/,\s*"[^"]*$/, '');
          repaired = repaired.replace(/,\s*$/, '');

          // Add missing closing brackets
          for (let i = 0; i < openBrackets - closeBrackets; i++) {
            repaired += ']';
          }
          for (let i = 0; i < openBraces - closeBraces; i++) {
            repaired += '}';
          }

          analysisResult = JSON.parse(repaired);
          console.log("Successfully repaired JSON by closing brackets");
        } catch {
          console.error("All JSON repair attempts failed:", responseText.substring(0, 500));
          return NextResponse.json(
            { error: "Failed to parse analysis results" },
            { status: 500 }
          );
        }
      }
    }

    // Validate the response has the expected structure
    if (!analysisResult.issues || !Array.isArray(analysisResult.issues)) {
      return NextResponse.json(
        { error: "Invalid analysis response structure" },
        { status: 500 }
      );
    }

    // Add unique IDs to each issue for React key props and potential future features
    const issuesWithIds: SchemaIssue[] = analysisResult.issues.map(
      (issue, index) => ({
        ...issue,
        id: `issue-${Date.now()}-${index}`,
      })
    );

    // Calculate summary statistics for the UI to display counts by category and severity
    const summary = {
      totalIssues: issuesWithIds.length,
      byCategory: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
    };

    for (const issue of issuesWithIds) {
      summary.byCategory[issue.category] =
        (summary.byCategory[issue.category] || 0) + 1;
      summary.bySeverity[issue.severity] =
        (summary.bySeverity[issue.severity] || 0) + 1;
    }

    // Extract performance score from response, with fallback default if not provided
    // Fallback calculates score based on issue count and severity
    let performance = analysisResult.performance;
    if (performance === undefined) {
      // Calculate fallback score: start at 100, deduct points per issue
      const warningCount = issuesWithIds.filter(i => i.severity === "warning").length;
      const suggestionCount = issuesWithIds.filter(i => i.severity === "suggestion").length;
      const infoCount = issuesWithIds.filter(i => i.severity === "info").length;
      performance = Math.max(0, 100 - (warningCount * 15) - (suggestionCount * 7) - (infoCount * 3));
    }

    // Ensure score is within valid range (0-100)
    performance = Math.min(100, Math.max(0, performance));

    // Return the analysis results with performance score, issues and summary
    return NextResponse.json({
      performance,
      issues: issuesWithIds,
      summary,
    });
  } catch (error) {
    console.error("Error in analyze-schema route:", error);

    // Handle specific Anthropic API errors with user-friendly messages
    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        return NextResponse.json(
          { error: "Too many requests. Please try again in a moment." },
          { status: 429 }
        );
      }
      if (error.status === 401) {
        return NextResponse.json(
          { error: "API configuration error" },
          { status: 500 }
        );
      }
      if (error.status === 503) {
        return NextResponse.json(
          {
            error: "AI service temporarily unavailable. Please try again soon.",
          },
          { status: 503 }
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to analyze schema" },
      { status: 500 }
    );
  }
}
