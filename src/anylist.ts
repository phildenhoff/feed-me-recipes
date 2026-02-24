import { AnyListClient } from '@anylist-napi/anylist-napi';
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

function resetClient(): void {
  client = null;
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

function isAuthError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('unauthorized') ||
      msg.includes('401') ||
      msg.includes('auth') ||
      msg.includes('token') ||
      msg.includes('expired') ||
      msg.includes('invalid session')
    );
  }
  return false;
}

export interface CreateRecipeParams {
  recipe: Recipe;
  sourceUrl: string;
  sourceName: string;
  credentials: AnyListCredentials;
  photo?: Buffer;
}

export async function createRecipe({
  recipe,
  sourceUrl,
  sourceName,
  credentials,
  photo,
}: CreateRecipeParams): Promise<CreatedRecipe> {
  await ensureLoggedIn(credentials);

  if (!client) {
    throw new Error('AnyList client not initialized');
  }

  console.log(`[anylist] Creating recipe: ${recipe.name}`);

  // Photo upload failure is non-fatal — the recipe must be saved regardless.
  let photoId: string | undefined;
  if (photo) {
    console.log(`[anylist] Uploading photo: ${photo.length} bytes`);
    try {
      photoId = await client.uploadPhoto(photo, 'recipe-cover.jpg');
      console.log(`[anylist] Photo uploaded: ${photoId}`);
    } catch (uploadError) {
      // If auth expired, reset client and retry once
      if (isAuthError(uploadError)) {
        console.log('[anylist] Photo upload failed with auth error, re-authenticating...');
        resetClient();
        await ensureLoggedIn(credentials);
        if (!client) {
          throw new Error('AnyList client not initialized after re-login');
        }
        try {
          photoId = await client.uploadPhoto(photo, 'recipe-cover.jpg');
          console.log(`[anylist] Photo uploaded after re-auth: ${photoId}`);
        } catch (retryError) {
          console.error('[anylist] Photo upload failed after re-auth, continuing without photo:', retryError);
        }
      } else {
        console.error('[anylist] Photo upload failed, continuing without photo:', uploadError);
      }
    }
  }

  const recipeOptions = {
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
    sourceName,
    sourceUrl: sourceUrl,
    photoId,
  };

  let created;
  try {
    created = await client.createRecipe(recipeOptions);
  } catch (createError) {
    // If auth expired, reset client and retry once
    if (isAuthError(createError)) {
      console.log('[anylist] Recipe creation failed with auth error, re-authenticating...');
      resetClient();
      await ensureLoggedIn(credentials);
      if (!client) {
        throw new Error('AnyList client not initialized after re-login');
      }
      created = await client.createRecipe(recipeOptions);
    } else {
      throw createError;
    }
  }

  console.log(`[anylist] Recipe created: ${created.id}`);

  return {
    id: created.id,
    name: created.name,
  };
}
