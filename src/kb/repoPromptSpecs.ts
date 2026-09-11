import type { PromptSpec } from "./registry.js";

export interface GeneratedRepo {
  name: "d2e" | "atlas3" | "trex";
  sourceRepo: string;
}

/** The three repos that make up an install, in generation order. */
export const GENERATED_REPOS: GeneratedRepo[] = [
  { name: "d2e", sourceRepo: "OHDSI/Data2Evidence" },
  { name: "atlas3", sourceRepo: "OHDSI/Atlas3" },
  { name: "trex", sourceRepo: "OHDSI/trex" },
];

/**
 * Bounded on purpose: an unbounded initial build over Atlas3 (a large Vue monorepo) or trex
 * (Rust + Deno) is the most expensive and least certain part of the design. Each spec names what
 * the answer engine actually needs from that repo and what is explicitly out of scope.
 */
export const REPO_PROMPT_SPECS: Record<GeneratedRepo["name"], PromptSpec> = {
  d2e: {
    audience: "partners running or evaluating a Data2Evidence install",
    exampleQuestions: [
      "How does the query engine turn a cohort definition into SQL?",
      "How is the platform assembled from its services and plugins?",
    ],
    focusAreas: [
      "service topology (portal, core, data-flow, trex sidecar) and how a request flows through it",
      "the plugin system and how plugins register",
      "how D2E consumes Atlas3, trex and the OHDSI WebAPI contract",
    ],
    scopeNotes:
      "Do not document deployment commands, environment variables or troubleshooting - the official docs tier covers those and outranks this tier.",
  },
  atlas3: {
    audience: "engineers integrating Atlas3 with a Data2Evidence install",
    exampleQuestions: [
      "How is a cohort definition represented and executed in Atlas3?",
      "How does Atlas3 talk to the backend?",
    ],
    focusAreas: [
      "cohort definition model and the path from definition to generated SQL",
      "the Vue application structure and its API layer",
      "what D2E embeds versus what Atlas3 provides upstream",
    ],
    scopeNotes:
      "Do not document installation, hosting or unrelated OHDSI tools. Keep to what a cross-repo integration answer needs.",
  },
  trex: {
    audience: "engineers who need to understand the SQL engine under a Data2Evidence install",
    exampleQuestions: [
      "What does the trex runtime do with a query?",
      "How does the WebAPI surface run inside the engine?",
    ],
    focusAreas: [
      "the query path (parse, plan, execute) and the storage/DuckDB layer",
      "the WebAPI-in-engine surface and how it is started",
      "the extension and plugin points D2E relies on",
    ],
    scopeNotes:
      "Do not document prerelease CI, publishing or developer tooling. Keep to runtime behaviour a D2E operator or integrator would ask about.",
  },
};

/** The version-independent contract tier, built once from the WebAPI spec branch. */
export const WEBAPI_CONTRACT = {
  repoName: "webapi-contract",
  sourceRepo: "OHDSI/WebAPI",
  ref: "webapi-3.0",
  pathPrefix: "repos/_shared/webapi-contract/",
  promptSpec: {
    audience: "engineers implementing or consuming the OHDSI WebAPI contract",
    exampleQuestions: [
      "What does the WebAPI 3.0 contract say a cohort endpoint returns?",
      "Which endpoints does the contract define?",
    ],
    focusAreas: [
      "the HTTP contract: resources, payload shapes, status codes",
      "the domain model the contract exposes (cohorts, sources, results)",
      "which parts Data2Evidence reimplements rather than ships",
    ],
    scopeNotes:
      "This is an upstream contract specification, not a component of a Data2Evidence install.",
  } satisfies PromptSpec,
} as const;
