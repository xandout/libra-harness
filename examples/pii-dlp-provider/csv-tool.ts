import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from 'libra-harness';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CustomerRecord {
  name: string;
  email: string;
  phone: string;
  account_id: string;
  balance: string;
  ssn: string;
}

function loadCustomers(): CustomerRecord[] {
  const csvPath = join(__dirname, 'customers.csv');
  const content = readFileSync(csvPath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const record: Record<string, string> = {};
    header.forEach((key, i) => { record[key] = values[i]; });
    return record as unknown as CustomerRecord;
  });
}

/**
 * Create a CSV lookup tool that searches customer records by name, email,
 * or account ID. Returns raw PII — the PII swap extension redacts it
 * before the LLM sees the result.
 */
export function createCsvLookupTool(): Tool {
  const customers = loadCustomers();

  return {
    name: 'lookup_customer',
    description: 'Look up a customer by name, email, or account ID. Returns their contact info and account balance.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The customer name, email, or account ID to search for.',
        },
      },
      required: ['query'],
    },
    async execute(args) {
      const query = String(args.query ?? '').toLowerCase();
      const match = customers.find(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.email.toLowerCase().includes(query) ||
          c.account_id.toLowerCase().includes(query),
      );

      if (!match) {
        return { toolCallId: '', content: `No customer found matching "${args.query}".` };
      }

      // Return raw PII — the PII swap extension will redact this
      // in the afterTool hook before the LLM sees it.
      return {
        toolCallId: '',
        content: `Customer found: Name: ${match.name}, Email: ${match.email}, Phone: ${match.phone}, Account: ${match.account_id}, Balance: $${match.balance}, SSN: ${match.ssn}`,
      };
    },
  };
}

/**
 * Get the list of known customer names from the CSV — used by the
 * PII detector to recognize person names.
 */
export function getKnownNames(): string[] {
  return loadCustomers().map((c) => c.name);
}
