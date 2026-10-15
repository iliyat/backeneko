import type { GraphQLSchema } from "graphql";
import { emptyMockModules, type MockModules } from "./mocks.ts";

export interface Runtime {
  schema: GraphQLSchema | null;
  modules: MockModules;
}

export const runtime: Runtime = {
  schema: null,
  modules: emptyMockModules(),
};
