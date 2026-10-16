import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const SRC_DIR = __dirname;
const ALLOWED_FILE = 'notices.ts';

function collectSources(dir: string, found: string[] = []): string[] {
    for (const entry of ts.sys.readDirectory(dir, ['.ts', '.tsx'], undefined, ['**/*'])) {
        const name = entry.slice(dir.length + 1);
        if (/\.test\.tsx?$/.test(entry) || name === ALLOWED_FILE) {
            continue;
        }
        found.push(entry);
    }
    return found;
}

function findViolationsInSource(file: string, text: string): string[] {
    const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const isTypeOnlySpecifier = (element: ts.ImportSpecifier): boolean =>
        element.getChildAt(0)?.kind === ts.SyntaxKind.TypeKeyword;
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            if (specifier === 'obsidian' && node.importClause
                && node.importClause.getChildAt(0)?.kind !== ts.SyntaxKind.TypeKeyword) {
                const named = node.importClause.namedBindings;
                if (named && ts.isNamedImports(named)) {
                    for (const element of named.elements) {
                        const importedName = (element.propertyName ?? element.name).text;
                        if (importedName === 'Notice' && !isTypeOnlySpecifier(element)) {
                            violations.push(`${file}: runtime Notice import${element.propertyName ? ` (aliased as ${element.name.text})` : ''}`);
                        }
                    }
                }
                if (node.importClause.name?.text === 'Notice') {
                    violations.push(`${file}: runtime default Notice import`);
                }
            }
            if (/(^|\/)errorNotice$/.test(specifier)) {
                violations.push(`${file}: stale import of renamed module '${specifier}'`);
            }
        }
        if (ts.isNewExpression(node)) {
            const expr = node.expression;
            if (ts.isIdentifier(expr) && expr.text === 'Notice') {
                violations.push(`${file}: direct 'new Notice' construction`);
            }
            if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'Notice') {
                violations.push(`${file}: direct 'new *.Notice' construction`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
}

function findViolations(file: string): string[] {
    return findViolationsInSource(file, ts.sys.readFile(file) ?? '');
}

describe('notice usage policy', () => {
    it('routes all production Notice construction through showYoutnoteNotice', () => {
        const files = collectSources(SRC_DIR);
        expect(files.length).toBeGreaterThan(0);
        expect(files.flatMap(findViolations)).toEqual([]);
    });

    it('keeps notices.ts as the only module importing the Notice constructor', () => {
        const source = ts.sys.readFile(`${SRC_DIR}/notices.ts`) ?? '';
        expect(source).toContain("from 'obsidian'");
        expect(ts.sys.fileExists(`${SRC_DIR}/ai/errorNotice.ts`)).toBe(false);
    });

    it.each<[string, string]>([
        ['direct import', "import { Notice } from 'obsidian';\nnew Notice('x');"],
        ['aliased import and construction', "import { Notice as Toast } from 'obsidian';\nnew Toast('x');"],
        ['direct construction', "import { showYoutnoteNotice } from './notices';\nnew Notice('x');"],
        ['namespace construction', "import * as Obsidian from 'obsidian';\nnew Obsidian.Notice('x');"],
    ])('rejects %s', (_label, text) => {
        expect(findViolationsInSource('fixture.ts', text)).not.toHaveLength(0);
    });

    it.each<[string, string]>([
        ['type-only import', "import type { Notice } from 'obsidian';\nconst n: Notice | null = null;"],
        ['inline type specifier', "import { type Notice, App } from 'obsidian';\nconst n: Notice | null = null;"],
        ['unrelated import', "import { Setting } from 'obsidian';\nnew Setting({} as never);"],
        ['helper usage', "import { showYoutnoteNotice } from './notices';\nshowYoutnoteNotice('x');"],
    ])('accepts %s', (_label, text) => {
        expect(findViolationsInSource('fixture.ts', text)).toEqual([]);
    });
});
