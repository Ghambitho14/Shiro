import { z } from "zod";

export const readFileSchema = z.object({
	path: z.string().min(1, "path requerido"),
});

export const writeFileSchema = z.object({
	path: z.string().min(1, "path requerido"),
	content: z.string().optional().default(""),
});

export const listDirSchema = z.object({
	path: z.string().optional().default(""),
});

export const readFileSystemSchema = z.object({
	path: z.string().min(1, "path requerido"),
});

export const writeFileSystemSchema = z.object({
	path: z.string().min(1, "path requerido"),
	content: z.string().optional().default(""),
});

export const listDirSystemSchema = z.object({
	path: z.string().optional().default(""),
});

export type ReadFileArgs = z.infer<typeof readFileSchema>;
export type WriteFileArgs = z.infer<typeof writeFileSchema>;
export type ListDirArgs = z.infer<typeof listDirSchema>;
export type ReadFileSystemArgs = z.infer<typeof readFileSystemSchema>;
export type WriteFileSystemArgs = z.infer<typeof writeFileSystemSchema>;
export type ListDirSystemArgs = z.infer<typeof listDirSystemSchema>;

export const toolSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
	read_file: readFileSchema,
	write_file: writeFileSchema,
	list_dir: listDirSchema,
	read_file_system: readFileSystemSchema,
	write_file_system: writeFileSystemSchema,
	list_dir_system: listDirSystemSchema,
};
