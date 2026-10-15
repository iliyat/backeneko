import type { DocumentNode, GraphQLError } from "graphql";
// graphql does not export its SDL validator from the package root, so this is
// the only internal import in the project. It is isolated here on purpose.
import { validateSDL as validateSDLInternal } from "graphql/validation/validate.js";

export function validateSDL(document: DocumentNode): ReadonlyArray<GraphQLError> {
  return validateSDLInternal(document);
}
