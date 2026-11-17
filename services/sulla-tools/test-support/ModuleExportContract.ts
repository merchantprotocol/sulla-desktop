import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ModuleFiles } from './ModuleFiles';

/**
 * Static scan of top-level exports and static named imports, for checking a container stub against the
 * Desktop modules that import it. Test support only; nothing is executed.
 */
export class ModuleExportContract {
  private readonly files: ModuleFiles;

  constructor(private readonly root: string) {
    this.files = new ModuleFiles(root);
  }

  /** Names the file exports at top level, sorted. Covers declarations and `export { a, b }` lists. */
  exportedNames(repoRelativeFile: string): string[] {
    const names: string[] = [];
    for (const statement of this.parse(repoRelativeFile).statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map(element => element.name.text));
      } else if (ts.isVariableStatement(statement) && isExported(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        isExported(statement) && statement.name
      ) {
        names.push(statement.name.text);
      }
    }
    return [...new Set(names)].sort();
  }

  /** Imported names (the exported-side name, not the local alias) that `fromFile` takes from `moduleFile`. */
  importedNames(fromFile: string, moduleFile: string): string[] {
    const names: string[] = [];
    for (const statement of this.parse(fromFile).statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (this.files.resolve(fromFile, statement.moduleSpecifier.text) !== moduleFile) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names.push(...bindings.elements.map(element => (element.propertyName ?? element.name).text));
      }
    }
    return [...new Set(names)].sort();
  }

  private parse(repoRelativeFile: string): ts.SourceFile {
    const absolute = path.join(this.root, repoRelativeFile);
    return ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
  }
}

function isExported(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [])
    .some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
