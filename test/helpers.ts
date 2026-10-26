import { emptyMockModules, type MockModule, type MockModules } from "../src/mocks.ts";

export function mockModules(options: {
  entities?: Record<string, MockModule>;
  root?: Record<string, Record<string, MockModule>>;
  overridden?: Record<string, string[]>;
}): MockModules {
  const modules = emptyMockModules();
  for (const [typeName, module] of Object.entries(options.entities ?? {})) {
    modules.entities.set(typeName, module);
  }
  for (const [typeName, fields] of Object.entries(options.root ?? {})) {
    modules.root.set(typeName, new Map(Object.entries(fields)));
  }
  for (const [typeName, fields] of Object.entries(options.overridden ?? {})) {
    modules.overriddenRoot.set(typeName, new Set(fields));
  }
  return modules;
}
