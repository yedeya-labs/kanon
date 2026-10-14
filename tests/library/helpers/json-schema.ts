// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON Schema, read keyword by keyword
type Schema = Record<string, any>;

/**
 * An independent reading of the published JSON Schema (`docs/notify/message-v1.schema.json`): the
 * keywords it may use, each read as JSON Schema 2020-12 defines it, and any other keyword a
 * failure, so the schema can't lean on a rule this reader would skip. Annotations are read as
 * nothing. Used by the contract's tests and by the generic webhook hook's, whose receiver
 * validates against the same file.
 */
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'x-kanon-whole-message']);
export function schemaAccepts(schema: Schema, v: unknown): boolean {
  for (const [k, rule] of Object.entries(schema)) {
    if (ANNOTATIONS.has(k)) continue;
    switch (k) {
      case 'type': {
        const t = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) && rule === 'integer' ? 'integer' : typeof v;
        if (t !== rule) return false;
        break;
      }
      case 'const': if (v !== rule) return false; break;
      case 'enum': if (!rule.includes(v)) return false; break;
      case 'minLength': if (typeof v === 'string' && [...v].length < rule) return false; break;
      case 'maxLength': if (typeof v === 'string' && [...v].length > rule) return false; break;
      case 'pattern': if (typeof v === 'string' && !new RegExp(rule, 'u').test(v)) return false; break;
      case 'maxItems': if (Array.isArray(v) && v.length > rule) return false; break;
      case 'items': if (Array.isArray(v) && !v.every((x) => schemaAccepts(rule, x))) return false; break;
      case 'required': if (v && typeof v === 'object' && !rule.every((p: string) => Object.hasOwn(v, p))) return false; break;
      case 'properties':
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [p, sub] of Object.entries(rule)) if (Object.hasOwn(v, p) && !schemaAccepts(sub as Schema, (v as Schema)[p])) return false;
        }
        break;
      case 'additionalProperties':
        if (rule !== false) throw new Error('additionalProperties other than false');
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some((p) => !Object.hasOwn(schema.properties ?? {}, p))) return false;
        break;
      default: throw new Error(`a keyword this reader doesn't know: ${k}`);
    }
  }
  return true;
}
