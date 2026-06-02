import { join } from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

function loadPublicKey(publicKeyName: string): crypto.KeyObject {
  const publicKeyPem = fs.readFileSync(join('keys', `${publicKeyName}.public.pem`), 'utf8');
  return crypto.createPublicKey(publicKeyPem);
}

export async function encryptFile(fileContent: string, publicKeyName: string): Promise<string> {
  const publicKey = loadPublicKey(publicKeyName);
  const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength ?? 2048;
  const keyBytes = Math.floor(modulusLength / 8);
  const hashBytes = 32; // SHA-256 digest size
  const maxChunkSize = keyBytes - (2 * hashBytes) - 2;
  if (maxChunkSize <= 0) {
    throw new Error('Invalid RSA key size for OAEP SHA-256.');
  }

  const input = Buffer.from(fileContent, 'utf8');
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += maxChunkSize) {
    const plaintextChunk = input.subarray(i, i + maxChunkSize);
    const encryptedChunk = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      plaintextChunk
    );
    chunks.push(encryptedChunk.toString('base64'));
  }

  return JSON.stringify({
    algorithm: 'RSA-OAEP-256',
    key: publicKeyName,
    chunkSize: maxChunkSize,
    chunks,
  });
}