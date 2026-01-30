/**
 * AnyList recipe creation via anylist-napi
 */

import { AnyListClient } from 'anylist-napi';
import type { Recipe } from './parser.js';

let client: AnyListClient | null = null;

export interface AnyListCredentials {
  email: string;
  password: string;
}

export interface CreatedRecipe {
  id: string;
  name: string;
}

export async function ensureLoggedIn(
  credentials: AnyListCredentials
): Promise<void> {
  if (client) {
    return;
  }

  console.log(`[anylist] Logging in as ${credentials.email}`);
  client = await AnyListClient.login(credentials.email, credentials.password);
  console.log('[anylist] Login successful');
}

export interface CreateRecipeParams {
  recipe: Recipe;
  sourceUrl: string;
  sourceUsername: string;
  credentials: AnyListCredentials;
  /** Photo buffer to upload as recipe cover image (optional) */
  photo?: Buffer;
}

export async function createRecipe({
  recipe,
  sourceUrl,
  sourceUsername,
  credentials,
  photo,
}: CreateRecipeParams): Promise<CreatedRecipe> {
  await ensureLoggedIn(credentials);

  if (!client) {
    throw new Error('AnyList client not initialized');
  }

  console.log(`[anylist] Creating recipe: ${recipe.name}`);
  if (photo) {
    console.log(`[anylist] Photo included: ${photo.length} bytes`);
  }

  const created = await client.createRecipe({
    name: recipe.name,
    ingredients: recipe.ingredients.map((ing) => ({
      name: ing.name,
      quantity: ing.quantity,
      note: ing.note,
    })),
    preparationSteps: recipe.steps,
    note: recipe.notes,
    servings: recipe.servings,
    prepTime: recipe.prepTime ?? 0, // Note: anylist-napi has a bug where these save as 0
    cookTime: recipe.cookTime ?? 0,
    sourceName: `Instagram @${sourceUsername}`,
    sourceUrl: sourceUrl,
    // TODO: Uncomment when anylist-napi supports photo upload
    // photo: photo,
  });

  console.log(`[anylist] Recipe created: ${created.id}`);

  return {
    id: created.id,
    name: created.name,
  };
}
