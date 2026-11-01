// Type-check one tsconfig in memory and print errors as JSON. Nothing is written to disk:
// emit, incremental build info, and composite output are all disabled.
import { relative } from 'node:path'
import ts from 'typescript'

const [configPath, rootDir] = process.argv.slice(2)
const configErrors = []
const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => configErrors.push(diagnostic) }
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)
if (!parsed) {
  console.log(JSON.stringify({ error: configErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ') || 'tsconfig could not be parsed' }))
  process.exit(0)
}

const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, declaration: false, declarationMap: false }
delete options.tsBuildInfoFile
const program = ts.createProgram({ rootNames: parsed.fileNames, options, projectReferences: parsed.projectReferences })
const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
  .filter((d) => d.file && d.category === ts.DiagnosticCategory.Error)
  .map((d) => {
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0)
    return {
      path: relative(rootDir, d.file.fileName).replaceAll('\\', '/'),
      line: line + 1,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' ').split('\n')[0],
    }
  })
  .filter((d) => !d.path.startsWith('..') && !d.path.includes('node_modules/'))
console.log(JSON.stringify({ diagnostics }))
