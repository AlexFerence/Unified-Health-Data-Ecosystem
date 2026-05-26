import * as fs from "fs";
import * as path from "path";
import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { type StructuredToolInterface } from "@langchain/core/tools";

// Resolve the files/ directory relative to the project root.
// This file is compiled to build/src/service/, so go up 3 levels.
const FILES_DIR = path.resolve(__dirname, "../../../files");

const MAX_FILES = 10;

/**
 * Validates a filename and returns the resolved absolute path.
 * Throws a descriptive error if the filename is unsafe or would escape FILES_DIR.
 */
function safeResolve(filename: string): string {
    if (!filename || filename.trim() === "") {
        throw new Error("Filename must not be empty.");
    }
    // Reject any path separators or traversal sequences
    if (/[/\\]/.test(filename) || filename.includes("..")) {
        throw new Error(
            `Invalid filename "${filename}": path separators and ".." are not allowed. Provide a plain filename only.`
        );
    }
    const resolved = path.resolve(FILES_DIR, filename);
    // Double-check the resolved path is still inside FILES_DIR
    if (!resolved.startsWith(FILES_DIR + path.sep) && resolved !== FILES_DIR) {
        throw new Error(`Access denied: "${filename}" resolves outside the files directory.`);
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// files_list
// ---------------------------------------------------------------------------
export const files_list_tool = tool(
    async () => {
        try {
            const entries = fs.readdirSync(FILES_DIR);
            const files = entries.filter((e) => {
                try {
                    return fs.statSync(path.join(FILES_DIR, e)).isFile();
                } catch {
                    return false;
                }
            });
            if (files.length === 0) {
                return "The files folder is empty.";
            }
            return `Files in files/ folder (${files.length}/${MAX_FILES}):\n${files.join("\n")}`;
        } catch (err) {
            return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
        }
    },
    {
        name: "files_list",
        description:
            "List all files in the files/ folder. Returns filenames and current count toward the 10-file limit.",
        schema: z.object({}),
    }
);

// ---------------------------------------------------------------------------
// files_read
// ---------------------------------------------------------------------------
export const files_read_tool = tool(
    async ({ filename }: { filename: string }) => {
        try {
            const filePath = safeResolve(filename);
            if (!fs.existsSync(filePath)) {
                return `File not found: "${filename}". Use files_list to see available files.`;
            }
            const content = fs.readFileSync(filePath, "utf-8");
            return content;
        } catch (err) {
            return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        }
    },
    {
        name: "files_read",
        description:
            "Read the full contents of a file in the files/ folder. Use this to load fitness-goals.md, scheduling-preferences.md, or any other file you have created.",
        schema: z.object({
            filename: z
                .string()
                .describe(
                    "Plain filename including extension, e.g. \"fitness-goals.md\". No path separators allowed."
                ),
        }),
    }
);

// ---------------------------------------------------------------------------
// files_write
// ---------------------------------------------------------------------------
export const files_write_tool = tool(
    async ({ filename, content }: { filename: string; content: string }) => {
        try {
            const filePath = safeResolve(filename);
            const isNew = !fs.existsSync(filePath);
            if (isNew) {
                // Count existing files to enforce cap
                const existing = fs.readdirSync(FILES_DIR).filter((e) => {
                    try {
                        return fs.statSync(path.join(FILES_DIR, e)).isFile();
                    } catch {
                        return false;
                    }
                });
                if (existing.length >= MAX_FILES) {
                    return (
                        `Cannot create "${filename}": the files/ folder already contains ${existing.length} files ` +
                        `(maximum is ${MAX_FILES}). Delete an existing file first with files_delete.`
                    );
                }
            }
            fs.writeFileSync(filePath, content, "utf-8");
            return isNew
                ? `Created "${filename}" successfully.`
                : `Updated "${filename}" successfully.`;
        } catch (err) {
            return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        }
    },
    {
        name: "files_write",
        description:
            "Create a new file or overwrite an existing file in the files/ folder. " +
            "Creating a new file is blocked when the folder already contains 10 files — delete one first. " +
            "Overwriting an existing file is always allowed regardless of count.",
        schema: z.object({
            filename: z
                .string()
                .describe(
                    "Plain filename including extension, e.g. \"my-plan.md\". No path separators allowed."
                ),
            content: z.string().describe("Full text content to write to the file."),
        }),
    }
);

// ---------------------------------------------------------------------------
// files_delete
// ---------------------------------------------------------------------------
export const files_delete_tool = tool(
    async ({ filename }: { filename: string }) => {
        try {
            const filePath = safeResolve(filename);
            if (!fs.existsSync(filePath)) {
                return `File not found: "${filename}". Use files_list to see available files.`;
            }
            if (!fs.statSync(filePath).isFile()) {
                return `"${filename}" is not a file and cannot be deleted with this tool.`;
            }
            fs.unlinkSync(filePath);
            return `Deleted "${filename}" successfully.`;
        } catch (err) {
            return `Error deleting file: ${err instanceof Error ? err.message : String(err)}`;
        }
    },
    {
        name: "files_delete",
        description:
            "Delete a file from the files/ folder. Only files inside the files/ folder can be deleted — no other paths are accessible.",
        schema: z.object({
            filename: z
                .string()
                .describe(
                    "Plain filename including extension, e.g. \"old-plan.md\". No path separators allowed."
                ),
        }),
    }
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export const getAllFilesTools = () => ({
    tools: {
        [files_list_tool.name]: files_list_tool,
        [files_read_tool.name]: files_read_tool,
        [files_write_tool.name]: files_write_tool,
        [files_delete_tool.name]: files_delete_tool,
    },
    requiredEnvVars: [] as string[],
});
