// Utilitario para gestión segura de preferencias de interfaz de usuario en POS (M05)
// Guarda favoritos por usuario en localStorage con protección contra fallos y JSON corrupto

const STORAGE_PREFIX = 'gtr_favs_';

export function getFavorites(userId?: number | string | null): number[] {
  try {
    const key = `${STORAGE_PREFIX}${userId || 'anon'}`;
    const data = localStorage.getItem(key);
    if (!data) return [];
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed.filter(id => typeof id === 'number' && Number.isInteger(id) && id > 0);
    }
    return [];
  } catch (err) {
    console.warn('[posUiPreferences] Error leyendo favoritos de localStorage:', err);
    return [];
  }
}

export function saveFavorites(userId: number | string | null | undefined, favorites: number[]): boolean {
  try {
    const key = `${STORAGE_PREFIX}${userId || 'anon'}`;
    const cleanList = Array.from(new Set(favorites)).filter(id => typeof id === 'number' && Number.isInteger(id) && id > 0);
    localStorage.setItem(key, JSON.stringify(cleanList));
    return true;
  } catch (err) {
    console.warn('[posUiPreferences] Error guardando favoritos en localStorage:', err);
    return false;
  }
}

export function toggleFavorite(productId: number, currentFavorites: number[], userId?: number | string | null): number[] {
  const cleanId = Number(productId);
  if (!cleanId || isNaN(cleanId)) return currentFavorites;

  let updated: number[];
  if (currentFavorites.includes(cleanId)) {
    updated = currentFavorites.filter(id => id !== cleanId);
  } else {
    updated = [...currentFavorites, cleanId];
  }

  saveFavorites(userId, updated);
  return updated;
}

export function isFavoriteProduct(productId: number, favorites: number[]): boolean {
  return favorites.includes(Number(productId));
}
