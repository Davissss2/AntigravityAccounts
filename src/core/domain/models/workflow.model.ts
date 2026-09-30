/**
 * Workflow Entity — Domain model
 *
 * Represents a workspace or category for organizing accounts
 * (e.g., "Casa", "Trabajo", "Clientes", "Testing").
 */

export interface Workflow {
  /** Unique identifier for the workflow */
  id: string;

  /** Display name of the workflow */
  name: string;

  /** Optional hex color code or accent color */
  color?: string;

  /** Optional icon or emoji */
  icon?: string;

  /** Creation timestamp (ISO string) */
  createdAt: string;
}
