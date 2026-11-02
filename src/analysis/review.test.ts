/// <reference types="node" />
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { analyzeRepository } from './engine'
import { RULES } from './review'
import type { AnalysisResult, SourceFile } from './types'

const wasmBasePath = fileURLToPath(new URL('../../public/wasm', import.meta.url))
const py = (path: string, source: string): SourceFile => ({ path, source, language: 'python' })
const ts = (path: string, source: string): SourceFile => ({ path, source, language: 'typescript' })

/** Build head from base by replacing (string) or deleting (null) files. */
function analyze(files: SourceFile[], edits: Record<string, string | null>) {
  const head = files
    .filter((file) => edits[file.path] !== null)
    .map((file) => (typeof edits[file.path] === 'string' ? { ...file, source: edits[file.path] as string } : file))
  return analyzeRepository({
    owner: 't', name: 'r',
    pullRequest: { number: 1, title: 't', author: 't', baseRef: 'main', headRef: 'change' },
    base: { sha: 'base', files },
    head: { sha: 'head', files: head },
  }, { wasmBasePath })
}

const rules = (result: AnalysisResult) => result.review.map((finding) => `${finding.severity} ${finding.ruleId} ${finding.affected.path}:${finding.affected.line}`)
const only = (result: AnalysisResult, prefix: string) => result.review.filter((finding) => finding.ruleId.startsWith(prefix))

describe('signature contracts — Python', () => {
  const lib = 'def charge(amount, currency):\n    return amount\n'
  const caller = py('app/billing.py', 'from app.lib import charge\n\ndef bill(total):\n    return charge(total, "usd")\n')

  it('flags a new required parameter that an untouched caller does not pass', async () => {
    const result = await analyze([py('app/lib.py', lib), caller], { 'app/lib.py': 'def charge(amount, currency, account):\n    return amount\n' })
    const [finding] = only(result, 'signature/')
    expect(finding).toMatchObject({
      ruleId: RULES.missingArgument,
      severity: 'high',
      confidence: 'confirmed',
      source: 'rule',
      changed: { path: 'app/lib.py', line: 1, revision: 'head' },
      affected: { path: 'app/billing.py', line: 4, symbol: 'bill' },
    })
    expect(finding.message).toContain('`account`')
    expect(finding.evidence).toHaveLength(1)
  }, 30_000)

  it('does not fire for a new parameter with a default, or when the caller was updated', async () => {
    const withDefault = await analyze([py('app/lib.py', lib), caller], { 'app/lib.py': 'def charge(amount, currency, account=None):\n    return amount\n' })
    expect(only(withDefault, 'signature/')).toEqual([])

    const updated = await analyze([py('app/lib.py', lib), caller], {
      'app/lib.py': 'def charge(amount, currency, account):\n    return amount\n',
      'app/billing.py': 'from app.lib import charge\n\ndef bill(total):\n    return charge(total, "usd", "acct")\n',
    })
    expect(only(updated, 'signature/')).toEqual([])
  }, 30_000)

  it('flags a renamed keyword parameter and names the replacement', async () => {
    const kwCaller = py('app/billing.py', 'from app.lib import charge\n\ndef bill(total):\n    return charge(total, currency="usd")\n')
    const result = await analyze([py('app/lib.py', lib), kwCaller], { 'app/lib.py': 'def charge(amount, unit):\n    return amount\n' })
    const ruleIds = only(result, 'signature/').map((finding) => finding.ruleId).sort()
    expect(ruleIds).toEqual([RULES.missingArgument, RULES.unknownKeyword])
    expect(result.review.find((finding) => finding.ruleId === RULES.unknownKeyword)?.message).toContain('renamed to `unit`')

    const absorbed = await analyze([py('app/lib.py', lib), kwCaller], { 'app/lib.py': 'def charge(amount, unit="usd", **extra):\n    return amount\n' })
    expect(only(absorbed, 'signature/')).toEqual([])
  }, 30_000)

  it('flags a removed positional parameter, but not when *args absorbs it', async () => {
    const removed = await analyze([py('app/lib.py', lib), caller], { 'app/lib.py': 'def charge(amount):\n    return amount\n' })
    expect(only(removed, 'signature/').map((f) => f.ruleId)).toEqual([RULES.tooManyArguments])

    const variadic = await analyze([py('app/lib.py', lib), caller], { 'app/lib.py': 'def charge(amount, *rest):\n    return amount\n' })
    expect(only(variadic, 'signature/')).toEqual([])
  }, 30_000)

  it('flags reordered positional parameters only when the caller was left unchanged', async () => {
    const result = await analyze([py('app/lib.py', lib), caller], { 'app/lib.py': 'def charge(currency, amount):\n    return amount\n' })
    expect(only(result, 'signature/')).toMatchObject([{ ruleId: RULES.reorderedParameters, severity: 'high' }])

    const fixed = await analyze([py('app/lib.py', lib), caller], {
      'app/lib.py': 'def charge(currency, amount):\n    return amount\n',
      'app/billing.py': 'from app.lib import charge\n\ndef bill(total):\n    return charge("usd", total)\n',
    })
    expect(only(fixed, 'signature/')).toEqual([])

    const keywordCaller = py('app/billing.py', 'from app.lib import charge\n\ndef bill(total):\n    return charge(amount=total, currency="usd")\n')
    const keywordsOnly = await analyze([py('app/lib.py', lib), keywordCaller], { 'app/lib.py': 'def charge(currency, amount):\n    return amount\n' })
    expect(only(keywordsOnly, 'signature/')).toEqual([])
  }, 30_000)

  it('accounts for self, staticmethod, and spread arguments', async () => {
    const cls = py('app/cart.py', 'class Cart:\n    def add(self, item):\n        return item\n\n    def fill(self, items):\n        for i in items:\n            self.add(i)\n')
    const added = await analyze([cls], { 'app/cart.py': cls.source.replace('def add(self, item)', 'def add(self, item, qty)') })
    expect(only(added, 'signature/')).toMatchObject([{ ruleId: RULES.missingArgument, affected: { line: 7 } }])
    const compatible = await analyze([cls], { 'app/cart.py': cls.source.replace('def add(self, item)', 'def add(self, item, qty=1)') })
    expect(only(compatible, 'signature/')).toEqual([])

    const util = py('app/util.py', 'class Util:\n    @staticmethod\n    def norm(x):\n        return x\n\ndef run(v):\n    return Util.norm(v)\n')
    const staticChanged = await analyze([util], { 'app/util.py': util.source.replace('def norm(x)', 'def norm(x, y)') })
    expect(only(staticChanged, 'signature/')).toMatchObject([{ ruleId: RULES.missingArgument }])

    const spread = py('app/billing.py', 'from app.lib import charge\n\ndef bill(args):\n    return charge(*args)\n')
    const unverifiable = await analyze([py('app/lib.py', lib), spread], { 'app/lib.py': 'def charge(amount, currency, account):\n    return amount\n' })
    expect(only(unverifiable, 'signature/')).toEqual([])
  }, 30_000)

  it('caps inferred links and signature-altering decorators at low severity', async () => {
    const files = [
      py('app/svc.py', 'class Service:\n    def run(self, job):\n        return job\n'),
      py('app/main.py', 'from app.svc import Service\n\ndef main(service):\n    return service.run("a")\n'),
    ]
    const inferred = await analyze(files, { 'app/svc.py': 'class Service:\n    def run(self, job, priority):\n        return job\n' })
    expect(only(inferred, 'signature/')).toMatchObject([{ ruleId: RULES.missingArgument, severity: 'low', confidence: 'inferred' }])

    const decorated = py('app/lib.py', 'import click\n\n@click.command()\ndef charge(amount):\n    return amount\n')
    const decoratedCaller = py('app/billing.py', 'from app.lib import charge\n\ndef bill():\n    return charge(1)\n')
    const result = await analyze([decorated, decoratedCaller], { 'app/lib.py': decorated.source.replace('charge(amount)', 'charge(amount, extra)') })
    expect(only(result, 'signature/')).toMatchObject([{ severity: 'low', confidence: 'inferred' }])
  }, 30_000)
})

describe('signature contracts — TypeScript', () => {
  const lib = ts('src/price.ts', 'export function price(amount: number, rate: number): number {\n  return amount * rate\n}\n')
  const caller = ts('src/cart.ts', 'import { price } from "./price"\n\nexport function total(x: number) {\n  return price(x, 2)\n}\n')

  it('flags a new required parameter and a removed one', async () => {
    const added = await analyze([lib, caller], { 'src/price.ts': lib.source.replace('rate: number)', 'rate: number, tax: number)') })
    expect(only(added, 'signature/')).toMatchObject([{ ruleId: RULES.missingArgument, severity: 'high', affected: { path: 'src/cart.ts', line: 4 } }])

    const removed = await analyze([lib, caller], { 'src/price.ts': lib.source.replace(', rate: number', '') })
    expect(only(removed, 'signature/')).toMatchObject([{ ruleId: RULES.tooManyArguments }])
  }, 30_000)

  it('does not fire for optional, defaulted, or rest parameters', async () => {
    for (const replacement of ['rate: number, tax?: number)', 'rate: number, tax = 0)', 'rate: number, ...more: number[])']) {
      const result = await analyze([lib, caller], { 'src/price.ts': lib.source.replace('rate: number)', replacement) })
      expect(only(result, 'signature/'), replacement).toEqual([])
    }
  }, 30_000)

  it('checks this.method() calls inside classes', async () => {
    const cls = ts('src/store.ts', 'export class Store {\n  put(key: string) {\n    return key\n  }\n  load() {\n    return this.put("a")\n  }\n}\n')
    const result = await analyze([cls], { 'src/store.ts': cls.source.replace('put(key: string)', 'put(key: string, value: string)') })
    expect(only(result, 'signature/')).toMatchObject([{ ruleId: RULES.missingArgument, affected: { line: 6 } }])
  }, 30_000)
})

describe('removed and renamed symbols', () => {
  it('flags a deleted Python function that is still imported and called', async () => {
    const files = [
      py('app/lib.py', 'def legacy():\n    return 1\n\ndef keep():\n    return 2\n'),
      py('app/use.py', 'from app.lib import legacy\n\ndef run():\n    return legacy()\n'),
    ]
    const result = await analyze(files, { 'app/lib.py': 'def keep():\n    return 2\n' })
    expect(rules(result)).toEqual([
      'high reference/broken-import app/use.py:1',
      'high reference/removed-symbol app/use.py:4',
    ])
    expect(result.review[0]).toMatchObject({ changed: { path: 'app/lib.py', line: 1, revision: 'base' } })
    expect(result.review[0].message).toContain('ImportError')
  }, 30_000)

  it('does not fire when the caller stopped using the deleted function', async () => {
    const files = [
      py('app/lib.py', 'def legacy():\n    return 1\n\ndef keep():\n    return 2\n'),
      py('app/use.py', 'from app.lib import legacy\n\ndef run():\n    return legacy()\n'),
    ]
    const result = await analyze(files, {
      'app/lib.py': 'def keep():\n    return 2\n',
      'app/use.py': 'from app.lib import keep\n\ndef run():\n    return keep()\n',
    })
    expect(only(result, 'reference/')).toEqual([])
  }, 30_000)

  it('does not fire when a function moved modules and the import was repointed', async () => {
    const files = [
      py('app/old.py', 'def util():\n    return 1\n'),
      py('app/new.py', 'X = 1\n'),
      py('app/use.py', 'from app.old import util\n\ndef run():\n    return util()\n'),
    ]
    const result = await analyze(files, {
      'app/old.py': null,
      'app/new.py': 'X = 1\n\ndef util():\n    return 1\n',
      'app/use.py': 'from app.new import util\n\ndef run():\n    return util()\n',
    })
    expect(only(result, 'reference/')).toEqual([])
  }, 30_000)

  it('flags a renamed TypeScript function that callers still use by its old name', async () => {
    const files = [
      ts('src/fmt.ts', 'export function fmt(n: number) {\n  return String(n)\n}\n'),
      ts('src/view.ts', 'import { fmt } from "./fmt"\n\nexport function view() {\n  return fmt(1)\n}\n'),
    ]
    const result = await analyze(files, { 'src/fmt.ts': 'export function formatNumber(n: number) {\n  return String(n)\n}\n' })
    expect(rules(result)).toEqual([
      'high reference/broken-import src/view.ts:1',
      'high reference/renamed-symbol src/view.ts:4',
    ])
    expect(result.review[1].message).toContain('renamed to `formatNumber`')

    const updated = await analyze(files, {
      'src/fmt.ts': 'export function formatNumber(n: number) {\n  return String(n)\n}\n',
      'src/view.ts': 'import { formatNumber } from "./fmt"\n\nexport function view() {\n  return formatNumber(1)\n}\n',
    })
    expect(only(updated, 'reference/')).toEqual([])
  }, 30_000)
})

describe('unupdated callers', () => {
  const files = [
    py('app/pricing.py', 'def discount(total):\n    return total * 0.9\n'),
    py('app/checkout.py', 'from app.pricing import discount\n\ndef checkout(total):\n    return discount(total)\n'),
    py('tests/test_pricing.py', 'from app.pricing import discount\n\ndef test_discount():\n    assert discount(10) == 9\n'),
  ]

  it('flags callers outside the PR as medium and ignores tests', async () => {
    const result = await analyze(files, { 'app/pricing.py': 'def discount(total):\n    return round(total * 0.9, 2)\n' })
    expect(rules(result)).toEqual(['medium impact/unupdated-caller app/checkout.py:4'])
    expect(result.review[0]).toMatchObject({ changed: { path: 'app/pricing.py', line: 1 }, affected: { symbol: 'checkout' } })
  }, 30_000)

  it('does not fire when the caller file is part of the PR', async () => {
    const result = await analyze(files, {
      'app/pricing.py': 'def discount(total):\n    return round(total * 0.9, 2)\n',
      'app/checkout.py': 'from app.pricing import discount\n\ndef checkout(total):\n    return discount(total) or 0\n',
    })
    expect(result.review).toEqual([])
  }, 30_000)

  it('reports inferred callers as low', async () => {
    const inferred = [
      py('app/svc.py', 'class Service:\n    def run(self, job):\n        return job\n'),
      py('app/main.py', 'from app.svc import Service\n\ndef main(service):\n    return service.run("a")\n'),
    ]
    const result = await analyze(inferred, { 'app/svc.py': 'class Service:\n    def run(self, job):\n        return job or None\n' })
    expect(result.review).toMatchObject([{ ruleId: RULES.unupdatedCaller, severity: 'low', confidence: 'inferred' }])
  }, 30_000)
})
