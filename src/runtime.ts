import type { GraphQLSchema } from "graphql";
import type { Interceptor } from "./request/intercept.ts";
import { emptyMockModules, type MockModules } from "./workspace/mocks.ts";

export interface Runtime {
  schema: GraphQLSchema | null;
  modules: MockModules;
  interceptors: Interceptor[];
}

export const runtime: Runtime = {
  schema: null,
  modules: emptyMockModules(),
  interceptors: [],
};
