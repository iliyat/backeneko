import { emptyMockModules, type MockModule, type MockModules } from "../src/mocks.ts";

export function mockModules(options: {
  entities?: Record<string, MockModule>;
  root?: Record<string, Record<string, MockModule>>;
}): MockModules {
  const modules = emptyMockModules();
  for (const [typeName, module] of Object.entries(options.entities ?? {})) {
    modules.entities.set(typeName, module);
  }
  for (const [typeName, fields] of Object.entries(options.root ?? {})) {
    modules.root.set(typeName, new Map(Object.entries(fields)));
  }
  return modules;
}
