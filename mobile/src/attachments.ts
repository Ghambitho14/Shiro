/**
 * Adjuntar desde el teléfono, como el botón + de la web: fotos (galería o cámara, reducidas a 1600 px
 * como hace la web) y archivos de texto (su contenido va dentro del mensaje).
 */
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import type { Attachment } from "./core/content";

const MAX_SIDE = 1600;
const MAX_TEXT = 200_000;
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|xml|html?|css|js|jsx|ts|tsx|py|java|kt|c|cpp|h|cs|go|rs|rb|php|sh|ps1|bat|ya?ml|toml|ini|cfg|sql|env)$/i;

async function toImage(asset: ImagePicker.ImagePickerAsset, i: number): Promise<Attachment> {
	const big = Math.max(asset.width, asset.height) > MAX_SIDE;
	const resize = big ? [{ resize: asset.width >= asset.height ? { width: MAX_SIDE } : { height: MAX_SIDE } }] : [];
	const out = await manipulateAsync(asset.uri, resize, { compress: 0.85, format: SaveFormat.JPEG, base64: true });
	return { kind: "image", name: asset.fileName ?? `foto-${i + 1}.jpg`, dataUrl: `data:image/jpeg;base64,${out.base64}` };
}

export async function pickImages(limit: number): Promise<Attachment[]> {
	const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: Math.max(1, limit), quality: 1 });
	if (res.canceled) return [];
	return Promise.all(res.assets.slice(0, limit).map(toImage));
}

export async function takePhoto(): Promise<Attachment[]> {
	const perm = await ImagePicker.requestCameraPermissionsAsync();
	if (!perm.granted) throw new Error("Shiro no tiene permiso para usar la cámara. Actívalo en los ajustes del teléfono.");
	const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
	if (res.canceled) return [];
	return Promise.all(res.assets.slice(0, 1).map(toImage));
}

export async function pickTextFiles(limit: number): Promise<Attachment[]> {
	const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
	if (res.canceled) return [];
	const out: Attachment[] = [];
	for (const a of res.assets.slice(0, limit)) {
		const isText = a.mimeType?.startsWith("text/") || a.mimeType === "application/json" || TEXT_EXT.test(a.name);
		if (!isText) throw new Error(`«${a.name}» no es un archivo de texto. Por ahora se pueden adjuntar fotos y archivos de texto (txt, md, código, csv…).`);
		if ((a.size ?? 0) > MAX_TEXT) throw new Error(`«${a.name}» es demasiado grande (máximo 200 KB).`);
		out.push({ kind: "file", name: a.name, text: await new File(a.uri).text() });
	}
	return out;
}
