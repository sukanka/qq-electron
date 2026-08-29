'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [archiveArgument, executableArgument] = process.argv.slice(2);

if (!archiveArgument || !executableArgument) {
  throw new Error(
    'Usage: node decrypt-application.js <application.asar> <qq-executable>',
  );
}

const archivePath = path.resolve(archiveArgument);
const executablePath = path.resolve(executableArgument);
const archiveStat = fs.statSync(archivePath);
const executableStat = fs.statSync(executablePath);

if (!archiveStat.isFile()) {
  throw new Error(`Not a regular ASAR file: ${archivePath}`);
}

if (!executableStat.isFile()) {
  throw new Error(`Not a regular QQ executable: ${executablePath}`);
}

if (fs.existsSync(`${archivePath}.unpacked`)) {
  throw new Error('application.asar.unpacked is not supported');
}

const aesBlockSize = 16;
const aesKeySize = 32;
const expectedBackground = Buffer.from(
  "require('../major.node').load('b_background', module);",
);

function safeNumber(value, name) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ELF ${name} is too large`);
  }
  return Number(value);
}

function readOnlySegments(file) {
  const image = fs.readFileSync(file);

  if (
    image.length < 64
    || image[0] !== 0x7f
    || image.subarray(1, 4).toString('ascii') !== 'ELF'
    || image[4] !== 2
    || image[5] !== 1
  ) {
    throw new Error('QQ executable is not a little-endian ELF64 file');
  }

  const tableOffset = safeNumber(
    image.readBigUInt64LE(32),
    'program header offset',
  );
  const entrySize = image.readUInt16LE(54);
  const entryCount = image.readUInt16LE(56);

  if (entrySize < 56 || entryCount === 0xffff) {
    throw new Error('Unsupported ELF program header table');
  }

  const tableEnd = tableOffset + entrySize * entryCount;
  if (tableEnd > image.length) {
    throw new Error('Invalid ELF program header table');
  }

  const segments = [];
  for (let index = 0; index < entryCount; index += 1) {
    const header = tableOffset + index * entrySize;
    const type = image.readUInt32LE(header);
    const flags = image.readUInt32LE(header + 4);

    // PT_LOAD with PF_R only contains constants but no executable code or
    // writable state. Tencent stores the obfuscated key in this segment.
    if (type !== 1 || flags !== 4) continue;

    const offset = safeNumber(
      image.readBigUInt64LE(header + 8),
      'segment offset',
    );
    const size = safeNumber(
      image.readBigUInt64LE(header + 32),
      'segment size',
    );
    const end = offset + size;

    if (end > image.length) throw new Error('Invalid ELF load segment');
    segments.push(image.subarray(offset, end));
  }

  if (segments.length === 0) {
    throw new Error('QQ executable has no read-only load segment');
  }

  return segments;
}

function decryptBuffer(encrypted, key) {
  if (encrypted.length < aesBlockSize * 2
      || (encrypted.length - aesBlockSize) % aesBlockSize !== 0) {
    throw new Error('Invalid encrypted file length');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    key,
    encrypted.subarray(0, aesBlockSize),
  );
  return Buffer.concat([
    decipher.update(encrypted.subarray(aesBlockSize)),
    decipher.final(),
  ]);
}

function findApplicationKey(encryptedBackground) {
  if (encryptedBackground.length < aesBlockSize * 2
      || (encryptedBackground.length - aesBlockSize) % aesBlockSize !== 0) {
    throw new Error('Invalid encrypted background.js length');
  }

  const iv = encryptedBackground.subarray(0, aesBlockSize);
  const firstCiphertextBlock = encryptedBackground.subarray(
    aesBlockSize,
    aesBlockSize * 2,
  );
  const expectedPrefix = expectedBackground.subarray(0, aesBlockSize);
  const matches = new Map();

  for (const segment of readOnlySegments(executablePath)) {
    let start = 0;

    for (let end = 0; end <= segment.length; end += 1) {
      if (end !== segment.length && segment[end] !== 0) continue;

      if (end - start === aesKeySize) {
        const obfuscated = segment.subarray(start, end);
        const candidate = Buffer.allocUnsafe(aesKeySize);

        for (let mask = 0; mask <= 0xff; mask += 1) {
          for (let index = 0; index < aesKeySize; index += 1) {
            candidate[index] = obfuscated[index] ^ mask;
          }

          const probe = crypto.createDecipheriv('aes-256-cbc', candidate, iv);
          probe.setAutoPadding(false);
          const firstPlainBlock = probe.update(firstCiphertextBlock);

          if (!firstPlainBlock.equals(expectedPrefix)) continue;

          try {
            const plain = decryptBuffer(encryptedBackground, candidate);
            if (plain.equals(expectedBackground)) {
              matches.set(candidate.toString('hex'), Buffer.from(candidate));
            }
          } catch {
            // A matching first block is only a candidate until padding and the
            // complete loader stub have both been verified.
          }
        }
      }

      start = end + 1;
    }
  }

  if (matches.size !== 1) {
    throw new Error(
      `Expected one application key in QQ executable, found ${matches.size}`,
    );
  }

  return matches.values().next().value;
}

function runAsar(args, stdout = 'inherit') {
  const result = spawnSync('asar', args, {
    stdio: ['ignore', stdout, 'inherit'],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`asar ${args[0]} failed with status ${result.status}`);
  }
}

function decryptFile(file, key) {
  const encrypted = fs.readFileSync(file);

  if (encrypted.length === 0) return false;

  try {
    fs.writeFileSync(file, decryptBuffer(encrypted, key));
    return true;
  } catch (error) {
    throw new Error(`Unable to decrypt ${file}`, { cause: error });
  }
}

function decryptTree(root, key) {
  const directories = [root];
  let entryCount = 0;
  let decryptedCount = 0;

  while (directories.length > 0) {
    const directory = directories.pop();

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      entryCount += 1;

      if (entry.isDirectory()) {
        directories.push(file);
      } else if (entry.isFile()) {
        if (decryptFile(file, key)) decryptedCount += 1;
      } else if (!entry.isSymbolicLink()) {
        throw new Error(`Unsupported ASAR entry type: ${file}`);
      }
    }
  }

  if (decryptedCount === 0) {
    throw new Error('application.asar contains no encrypted files');
  }

  return { decryptedCount, entryCount };
}

const temporaryRoot = fs.mkdtempSync(
  path.join(path.dirname(archivePath), '.qq-application-'),
);
const extractedRoot = path.join(temporaryRoot, 'application');
const outputArchive = path.join(temporaryRoot, 'application.asar');
const listingPath = path.join(temporaryRoot, 'entries.txt');

try {
  runAsar(['extract', archivePath, extractedRoot]);
  const key = findApplicationKey(
    fs.readFileSync(path.join(extractedRoot, 'background.js')),
  );
  const { decryptedCount, entryCount } = decryptTree(extractedRoot, key);
  const index = fs.readFileSync(
    path.join(extractedRoot, 'renderer', 'index.html'),
    'utf8',
  );

  if (!/^\s*<!doctype html>/i.test(index)) {
    throw new Error('Decrypted renderer/index.html is not valid HTML');
  }

  runAsar(['pack', extractedRoot, outputArchive]);
  const listing = fs.openSync(listingPath, 'w');
  try {
    runAsar(['list', outputArchive], listing);
  } finally {
    fs.closeSync(listing);
  }
  const packedEntries = fs.readFileSync(listingPath, 'utf8')
    .split('\n')
    .filter(Boolean).length;

  if (packedEntries !== entryCount) {
    throw new Error(
      `Repacked ASAR entry count changed: ${entryCount} -> ${packedEntries}`,
    );
  }

  fs.chmodSync(outputArchive, archiveStat.mode);
  fs.renameSync(outputArchive, archivePath);
  console.log(`Decrypted and repacked ${decryptedCount} application files`);
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}
