# CodeImpact

**CodeImpact** is a deterministic static-analysis and dependency-mapping engine designed to analyze pull requests, identify cross-file code impact, and recommend relevant tests prior to merging. 

By running abstract syntax tree (AST) parsing via WebAssembly (WASM), CodeImpact generates inspectable dependency graphs and evidence-backed AI explanations entirely within the client environment—eliminating the need to execute untrusted repository code.

## Performance Benchmarks

CodeImpact was evaluated against a benchmark dataset of 100+ historical open-source pull requests. The analysis engine achieved the following validated metrics:

* **Test-Selection Recall:** 91% identification of relevant test cases.
* **Test-Suite Reduction:** 60% reduction in required test execution volume compared to a full-suite baseline.
* **Analysis Latency:** 2.1 seconds median end-to-end processing time.
* **AI Evidence-Grounding:** 97% of generated explanations correctly mapped to deterministic source provenance.

## System Architecture

The application is built as a single-page application (SPA) optimized for client-side code analysis. 

* **Frontend Framework:** React, Vite, TypeScript
* **UI/Styling:** Tailwind CSS, shadcn/ui (`src/components/ui/`)
* **Static Analysis:** Tree-sitter compiled to WASM (`public/wasm/`)
* **Graph Visualization:** Interactive rendering via `ImpactGraph.tsx`

### Core Modules

* `src/analysis/parser.ts`: Manages the WASM Tree-sitter instances for Python and TypeScript, extracting ASTs and resolving symbol signatures.
* `src/analysis/engine.ts`: Constructs the directed dependency graph, identifies modified symbols from diffs, and computes shortest-path traversals to rank impacted files and tests.
* `src/analysis/benchmark.ts`: Automated evaluation pipeline for calculating precision, recall, and suite reduction against historical test fixtures.
* `src/components/EvidencePanel.tsx`: Surfaces the AI explanation layer, mapping generated insights to exact AST node locations and dependency edges.
* `src/components/TestTable.tsx`: Renders the ranked test recommendations with links to inspectable provenance.

## Getting Started

### Prerequisites
* Node.js (v18+)
* npm or pnpm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/CodeImpact.git
   cd CodeImpact
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```

## Development and Testing

CodeImpact relies on deterministic heuristics for graph traversal. To run the automated analysis tests and benchmark suite:

```bash
npm run test
```
*(Tests are located alongside the analysis engine in `src/analysis/engine.test.ts` and `src/analysis/benchmark.test.ts`)*

## Security Model

CodeImpact is designed with a zero-execution security posture. All source code is treated as untrusted text. The analysis relies strictly on AST parsing, and the AI explanation engine is structurally constrained to reference only deterministic graph nodes and file bounds extracted by Tree-sitter.

## License

[MIT License](LICENSE)
