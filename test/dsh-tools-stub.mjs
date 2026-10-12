// A faithful stand-in for `@deepseek-ai/dsh-tools`'s `defineTool`.
//
// Why not just `const defineTool = (x) => x`: the real one COMPILES the author-facing
// specs and throws on anything outside its subset. A pass-through stub would happily
// accept a plugin the host then refuses to load — and per the market's own README a
// plugin that fails to load takes the whole DSH process down with it. So this stub
// enforces the same subset, using the tables read out of the real
// `dsh-tools/lib/index.js`:
//
//   * SCHEMA_TYPES               object/array/string/number/integer/boolean/null
//   * constraint keywords        type/oneOf/properties/required/additionalProperties/
//                                items/enum/const
//   * items                      only on `array`
//   * properties/required/       only on `object`
//     additionalProperties
//   * parameters                 a map of { type, description, required? }
//
// It is not a reimplementation of the runtime — it just refuses the same shapes.

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);

const ANNOTATION_KEYWORDS = new Set([
  'description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment',
]);

const KEYWORD_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
};

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkSchema(node, path, violations) {
  if (!isRecord(node)) {
    violations.push(`${path} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    violations.push(
      `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/`
      + 'additionalProperties/items/enum/const + annotations)',
    );
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
    violations.push(`${path}.description must be a string`);
  }

  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    violations.push(`${path} cannot declare both type and oneOf`);
    return;
  }
  if (!hasType && !hasOneOf) {
    violations.push(`${path} must declare type or oneOf`);
    return;
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`);
      return;
    }
    node.oneOf.forEach((s, i) => checkSchema(s, `${path}.oneOf[${i}]`, violations));
    return;
  }

  const type = node.type;
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    return;
  }
  for (const [key, allowed] of Object.entries(KEYWORD_TYPES)) {
    if (Object.hasOwn(node, key) && !allowed.includes(type)) {
      violations.push(`${path}.${key} is not supported on type "${type}"`);
    }
  }
  if (type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      if (!isRecord(node.properties)) {
        violations.push(`${path}.properties must be an object of schemas`);
      } else {
        for (const [k, v] of Object.entries(node.properties)) {
          checkSchema(v, `${path}.properties.${k}`, violations);
        }
      }
    }
    if (Object.hasOwn(node, 'required') && !Array.isArray(node.required)) {
      violations.push(`${path}.required must be an array`);
    }
  }
  if (type === 'array' && Object.hasOwn(node, 'items')) {
    checkSchema(node.items, `${path}.items`, violations);
  }
}

/** Mirrors `parameterSchemaSpecToJsonSchema`: an implicit open object of property specs. */
function compileParameters(spec, violations) {
  if (!isRecord(spec)) {
    violations.push('parameters must be an object');
    return {};
  }
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (!isRecord(value)) {
      violations.push(`parameters.${key} must be an object`);
      continue;
    }
    // `required` is an AUTHOR-facing field here, not a schema keyword: the real compiler
    // lifts it into the parameter object's root and validates what remains. Validating it
    // in place would reject `{ type: 'string', required: true }`, which every real plugin
    // writes.
    const { required: isRequired, ...propertySchema } = value;
    checkSchema(propertySchema, `parameters.${key}`, violations);
    if (isRequired === true) required.push(key);
    properties[key] = propertySchema;
  }
  return required.length ? { type: 'object', properties, required } : { type: 'object', properties };
}

export class JsonSchemaError extends Error {}

export function defineTool(options) {
  const violations = [];
  if (!isRecord(options)) throw new Error('defineTool(options): options must be an object');
  if (typeof options.name !== 'string' || !options.name) {
    violations.push('name must be a non-empty string');
  }
  if (typeof options.description !== 'string' || !options.description) {
    violations.push(`${options.name}: description must be a non-empty string`);
  }
  if (typeof options.execute !== 'function') {
    violations.push(`${options.name}: execute must be a function`);
  }
  if (!isRecord(options.output) || typeof options.output.render !== 'function') {
    violations.push(`${options.name}: output.render must be a function`);
  }

  const parameters = compileParameters(options.parameters ?? {}, violations);

  let outputSchema = null;
  if (isRecord(options.output) && options.output.schema !== undefined) {
    outputSchema = options.output.schema;
    checkSchema(outputSchema, 'schema', violations);
    if (isRecord(outputSchema) && outputSchema.type !== 'object') {
      violations.push('schema.type must be "object" (tool output is object-rooted)');
    }
  } else {
    violations.push(`${options.name}: output.schema is required`);
  }

  if (violations.length) throw new JsonSchemaError(violations.join('; '));

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
    },
    execute: options.execute,
  };
}
