import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const BACKEND_SRC = 'backend';
const FORBIDDEN_EXTENSIONS = ['.tsx', '.jsx', '.css'];

async function checkDirectory(dir: string) {
  const files = await readdir(dir, { withFileTypes: true });
  let hasError = false;

  for (const file of files) {
    const path = join(dir, file.name);

    if (file.isDirectory()) {
      if (await checkDirectory(path)) {
        hasError = true;
      }
    } else {
      const ext = extname(file.name).toLowerCase();
      if (FORBIDDEN_EXTENSIONS.includes(ext)) {
        console.error(`❌ Forbidden frontend file found in backend directory: ${path}`);
        hasError = true;
      }
    }
  }

  return hasError;
}

async function main() {
  console.log('🔍 Verifying backend structure...');
  const hasError = await checkDirectory(BACKEND_SRC);

  if (hasError) {
    console.error('\n🚫 Frontend files (.tsx, .jsx, .css) are NOT allowed in root src/.');
    console.error('Please move them to the frontend/ directory.');
    process.exit(1);
  }

  console.log('✅ Backend structure verified.');
}

main().catch(console.error);

