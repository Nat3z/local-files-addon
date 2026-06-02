import fs from 'node:fs';
import { join, resolve } from 'node:path';
import crypto from 'node:crypto';

const SEPARATOR = '--------------------------------------------------------';

function usage(): never {
  console.error('Usage: bun run decrypt-logs.ts <paste_url> [key_name] [output_dir]');
  process.exit(1);
}

function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : 'log';
}

function splitLogs(plaintext: string): Array<{ name: string; content: string }> {
  const lines = plaintext.replace(/\r\n/g, '\n').split('\n');
  const entries: Array<{ name: string; content: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const isHeaderBlock =
      lines[i] === SEPARATOR &&
      lines[i + 2] === SEPARATOR &&
      typeof lines[i + 1] === 'string' &&
      lines[i + 1].startsWith('- ');

    if (!isHeaderBlock) {
      i += 1;
      continue;
    }

    const name = lines[i + 1].slice(2).trim();
    i += 3;
    const contentLines: string[] = [];

    while (i < lines.length) {
      const nextHeaderBlock =
        lines[i] === SEPARATOR &&
        lines[i + 2] === SEPARATOR &&
        typeof lines[i + 1] === 'string' &&
        lines[i + 1].startsWith('- ');
      if (nextHeaderBlock) break;
      contentLines.push(lines[i]);
      i += 1;
    }

    while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
      contentLines.pop();
    }

    entries.push({
      name,
      content: contentLines.join('\n'),
    });
  }

  if (entries.length === 0) {
    return [{ name: 'decrypted', content: plaintext }];
  }
  return entries;
}

function extractEncryptedJson(rawResponse: string): string {
  const lines = rawResponse.replace(/\r\n/g, '\n').split('\n');
  const jsonLine = lines.find((line) => line.trim().startsWith('{"algorithm":"RSA-OAEP-256"'));
  if (!jsonLine) {
    throw new Error('Could not find encrypted JSON in response.');
  }
  return jsonLine.trim();
}

async function main(): Promise<void> {
  const [url, keyNameArg, outputDirArg] = process.argv.slice(2);
  if (!url) usage();

  const keyName = keyNameArg ?? 'ogi';
  const outputDir = resolve(outputDirArg ?? join('output', `decrypted-logs-${Date.now()}`));
  const privateKeyPath = join('keys', `${keyName}.private.pem`);

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(`Private key not found at ${privateKeyPath}`);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  const rawResponse = await response.text();
  const payloadJson = extractEncryptedJson(rawResponse);
  const payload = JSON.parse(payloadJson) as {
    algorithm: string;
    key: string;
    chunks: string[];
  };

  if (payload.algorithm !== 'RSA-OAEP-256' || !Array.isArray(payload.chunks)) {
    throw new Error('Unsupported payload format.');
  }

  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const decryptedChunks = payload.chunks.map((chunk, idx) => {
    try {
      return crypto.privateDecrypt(
        {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(chunk, 'base64')
      );
    } catch (error) {
      throw new Error(`Failed to decrypt chunk ${idx}: ${(error as Error).message}`);
    }
  });

  const plaintext = Buffer.concat(decryptedChunks).toString('utf8');
  const logs = splitLogs(plaintext);

  fs.mkdirSync(outputDir, { recursive: true });
  logs.forEach((log, idx) => {
    const prefix = String(idx + 1).padStart(2, '0');
    const fileName = `${prefix}-${sanitizeFilename(log.name)}.log`;
    fs.writeFileSync(join(outputDir, fileName), log.content, 'utf8');
  });

  const combinedPath = join(outputDir, 'combined-decrypted.txt');
  fs.writeFileSync(combinedPath, plaintext, 'utf8');

  console.log(`Decrypted ${logs.length} log file(s) to ${outputDir}`);
  console.log(`Combined output: ${combinedPath}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
