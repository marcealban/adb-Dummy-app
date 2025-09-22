#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const sharpPackageJsonPath = path.join(projectRoot, 'node_modules', 'sharp', 'package.json');
const emnapiPackageJsonPath = path.join(projectRoot, 'node_modules', '@emnapi', 'runtime', 'package.json');

function log(message) {
  process.stdout.write(`${message}\n`);
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`No se pudo leer ${filePath}: ${error.message}`);
  }
}

function isPackageInstalled(packageJsonPath) {
  try {
    return fs.existsSync(packageJsonPath);
  } catch (error) {
    return false;
  }
}

function installPackage(spec) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install', spec, '--no-save'];
  const result = spawnSync(npmCommand, args, {
    cwd: projectRoot,
    stdio: 'inherit'
  });

  if (result.error) {
    throw new Error(`No se pudo ejecutar npm: ${result.error.message}`);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`El comando npm finalizó con código ${result.status}.`);
  }

  if (result.status === null) {
    throw new Error('La instalación fue interrumpida.');
  }
}

function ensureRuntimeStub() {
  const runtimeDir = path.dirname(emnapiPackageJsonPath);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
  } catch (error) {
    console.error(`No se pudo crear el directorio para @emnapi/runtime: ${error.message}`);
    process.exit(1);
  }

  const stubPackage = {
    name: '@emnapi/runtime',
    version: '0.0.0-stub',
    description: 'Stub generado automáticamente para cumplir dependencias opcionales durante el empaquetado'
  };

  try {
    fs.writeFileSync(emnapiPackageJsonPath, `${JSON.stringify(stubPackage, null, 2)}\n`, 'utf8');
    const indexPath = path.join(runtimeDir, 'index.js');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, "module.exports = {};\n", 'utf8');
    }
    log('Se creó un stub de @emnapi/runtime.');
  } catch (error) {
    console.error(`No se pudo crear el stub de @emnapi/runtime: ${error.message}`);
    process.exit(1);
  }
}

let dependencySpec;
try {
  const pkg = readJson(packageJsonPath);
  dependencySpec = pkg?.dependencies?.sharp;
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (!dependencySpec) {
  log('La dependencia "sharp" no está declarada en package.json; no se realizará ninguna instalación.');
  process.exit(0);
}

if (!isPackageInstalled(sharpPackageJsonPath)) {
  log('sharp no está instalado localmente. Iniciando instalación previa al empaquetado...');
  try {
    installPackage(`sharp@${dependencySpec}`);
    log('sharp se instaló correctamente.');
  } catch (error) {
    console.error(`No se pudo instalar sharp: ${error.message}`);
    process.exit(1);
  }
} else {
  try {
    const installed = readJson(sharpPackageJsonPath);
    if (installed?.version) {
      log(`sharp ya está instalado (versión ${installed.version}).`);
    } else {
      log('sharp ya está instalado.');
    }
  } catch {
    log('sharp ya está instalado.');
  }
}

const runtimeSpec = (() => {
  try {
    const sharpPkg = readJson(sharpPackageJsonPath);
    return sharpPkg?.devDependencies?.['@emnapi/runtime'] || '^1.2.0';
  } catch {
    return '^1.2.0';
  }
})();

if (!isPackageInstalled(emnapiPackageJsonPath)) {
  log('@emnapi/runtime no está instalado. Instalación requerida por sharp para el empaquetado...');
  let installError = null;
  try {
    installPackage(`@emnapi/runtime@${runtimeSpec}`);
  } catch (error) {
    installError = error;
  }

  if (installError) {
    log(`No se pudo instalar @emnapi/runtime desde npm (${installError.message}). Se intentará crear un stub.`);
    ensureRuntimeStub();
  } else if (!isPackageInstalled(emnapiPackageJsonPath)) {
    log('@emnapi/runtime no está disponible tras la instalación. Se creará un stub para continuar.');
    ensureRuntimeStub();
  } else {
    log('@emnapi/runtime se instaló correctamente.');
  }
} else {
  log('@emnapi/runtime ya está instalado.');
}
