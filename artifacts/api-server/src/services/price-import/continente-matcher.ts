import type {
  ContinenteCatalogProduct,
  ContinenteExternalProductMapping,
  ContinenteMappingRepository,
  ContinenteProductMatch,
  ContinenteProductObservation,
  ProductMatchObservation,
} from "./continente-types.js";

export class EmptyContinenteMappingRepository implements ContinenteMappingRepository {
  async findMappings(): Promise<readonly ContinenteExternalProductMapping[]> {
    return [];
  }
}

function normalizeText(value: string | null): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-PT")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function withoutBrandSuffix(name: string | null, brand: string | null): string {
  const normalizedName = normalizeText(name);
  const normalizedBrand = normalizeText(brand);
  if (!normalizedBrand) return normalizedName;
  const suffix = ` ${normalizedBrand}`;
  const withoutSuffix = normalizedName.endsWith(suffix)
    ? normalizedName.slice(0, -suffix.length).trim()
    : normalizedName;
  return withoutSuffix || normalizedName;
}

function normalizeUnit(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (["un", "unidade", "unidades", "unit", "units", "c62"].includes(normalized)) {
    return "un";
  }
  if (["kg", "kilogram", "kilograms", "kgm"].includes(normalized)) return "kg";
  if (["g", "gram", "grams", "grm"].includes(normalized)) return "g";
  if (["mg", "milligram", "milligrams", "mgm"].includes(normalized)) return "mg";
  if (["l", "liter", "litre", "liters", "litres", "ltr"].includes(normalized)) return "l";
  if (["ml", "milliliter", "millilitre", "milliliters", "millilitres", "mlt"].includes(normalized)) {
    return "ml";
  }
  if (["cl", "centiliter", "centilitre", "clt"].includes(normalized)) return "cl";
  return normalized;
}

function quantityIsVisibleInName(
  name: string | null,
  quantity: number,
  unit: string,
): boolean {
  if (!name) return false;
  const normalizedUnit = normalizeUnit(unit);
  if (!normalizedUnit) return false;
  const escapedUnit = normalizedUnit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const number = quantity.toString().replace(".", "[.,]");
  const unitPattern = normalizedUnit === "un"
    ? "(?:un(?:idades?)?|unid)"
    : escapedUnit;
  return new RegExp(`(?:^|\\D)${number}\\s*${unitPattern}(?:\\b|$)`, "i").test(name);
}

function catalogBarcode(value: string | null): string | null {
  return value?.trim() || null;
}

function identityMatches(
  mapping: ContinenteExternalProductMapping,
  observation: ProductMatchObservation,
): boolean {
  return mapping.verified === true &&
    mapping.sourceType === observation.sourceType &&
    mapping.externalProductId === observation.externalProductId &&
    typeof mapping.productId === "string" &&
    mapping.productId.trim().length > 0 &&
    Number.isFinite(mapping.confidence) &&
    mapping.confidence >= 0 &&
    mapping.confidence <= 1;
}

function result(
  level: ContinenteProductMatch["level"],
  method: ContinenteProductMatch["method"],
  confidence: number,
  candidates: readonly ContinenteCatalogProduct[],
  explanation: string,
): ContinenteProductMatch {
  return {
    level,
    method,
    confidence,
    candidateCount: candidates.length,
    product: candidates.length === 1 ? candidates[0]! : null,
    explanation,
  };
}

async function matchProduct(
  observation: ProductMatchObservation,
  catalog: readonly ContinenteCatalogProduct[],
  mappings: ContinenteMappingRepository,
  preferSourceNative: boolean,
): Promise<ContinenteProductMatch> {
  const activeCatalog = catalog.filter((product) =>
    product.active &&
    typeof product.id === "string" && product.id.trim() &&
    typeof product.name === "string" && product.name.trim()
  );

  if (observation.externalProductId) {
    const mappingRows = await mappings.findMappings(
      observation.sourceType,
      observation.externalProductId,
    );
    const verifiedMappings = mappingRows.filter((mapping) =>
      identityMatches(mapping, observation)
    );
    if (verifiedMappings.length > 1) {
      return result(
        "ambiguous",
        "verified_external_mapping",
        0,
        verifiedMappings.map((mapping) => ({
          id: mapping.productId,
          name: "",
          brand: null,
          barcode: null,
          unit: null,
          active: true,
        })),
        "There is more than one verified persisted mapping for this external identity.",
      );
    }
    if (verifiedMappings.length === 1) {
      const mapping = verifiedMappings[0]!;
      const products = activeCatalog.filter((product) => product.id === mapping.productId);
      if (products.length === 1) {
        return result(
          "exact",
          "verified_external_mapping",
          mapping.confidence,
          products,
          "A single verified external-product mapping points to an active catalog product.",
        );
      }
      if (products.length > 1) {
        return result(
          "ambiguous",
          "verified_external_mapping",
          0,
          [],
          "The verified mapping points to a non-unique catalog product ID.",
        );
      }
    }
  }

  if (preferSourceNative && observation.externalProductId) {
    const sourceNative = catalog.filter((product) =>
      product.sourceType === observation.sourceType &&
      product.externalId === observation.externalProductId
    );
    if (sourceNative.length > 1) {
      return result(
        "ambiguous",
        "source_native_exact",
        0,
        sourceNative,
        "More than one catalog product has this exact source-native identity.",
      );
    }
    if (sourceNative.length === 1) {
      const product = sourceNative[0]!;
      if (product.active) {
        return result(
          "exact",
          "source_native_exact",
          1,
          [product],
          "An active catalog product already has this exact source-native identity.",
        );
      }
      return {
        level: "unmatched",
        method: "source_native_inactive",
        confidence: 0,
        candidateCount: 1,
        product,
        explanation: "This source-native catalog product exists but is inactive; it is not a price target.",
      };
    }
  }

  const barcode = catalogBarcode(observation.barcode);
  if (barcode) {
    const barcodeMatches = activeCatalog.filter(
      (product) => catalogBarcode(product.barcode) === barcode,
    );
    if (barcodeMatches.length === 1) {
      return result(
        "exact",
        "barcode_exact",
        1,
        barcodeMatches,
        "The source barcode exactly equals the barcode of one active catalog product.",
      );
    }
    if (barcodeMatches.length > 1) {
      return result(
        "ambiguous",
        "barcode_exact",
        0,
        barcodeMatches,
        "The exact barcode is assigned to more than one active catalog product.",
      );
    }
  }

  const sourceName = withoutBrandSuffix(observation.name, observation.brand);
  const sourceBrand = normalizeText(observation.brand);
  if (!sourceName || (!sourceBrand && observation.packageQuantity === null)) {
    return result(
      "unmatched",
      null,
      0,
      [],
      "No exact barcode was found and the source lacks the brand or package evidence needed for a conservative name match.",
    );
  }

  const nameBrandMatches = activeCatalog.filter((product) => {
    const candidateName = withoutBrandSuffix(product.name, product.brand);
    if (!candidateName || candidateName !== sourceName) return false;

    if (sourceBrand) {
      if (normalizeText(product.brand) !== sourceBrand) return false;
    } else if (observation.packageQuantity !== null) {
      const candidateUnit = normalizeUnit(product.unit);
      const sourceUnit = normalizeUnit(observation.packageUnit);
      if (!sourceUnit || candidateUnit !== sourceUnit) return false;
    }

    if (observation.packageUnit !== null) {
      const sourceUnit = normalizeUnit(observation.packageUnit);
      const candidateUnit = normalizeUnit(product.unit);
      if (!sourceUnit || !candidateUnit || sourceUnit !== candidateUnit) return false;
    }
    if (observation.packageQuantity !== null) {
      if (!observation.packageUnit) return false;
      if (
        !quantityIsVisibleInName(
          observation.name,
          observation.packageQuantity,
          observation.packageUnit,
        ) ||
        !quantityIsVisibleInName(
          product.name,
          observation.packageQuantity,
          observation.packageUnit,
        )
      ) {
        return false;
      }
    }
    return true;
  });

  if (nameBrandMatches.length === 1) {
    return result(
      "high_confidence",
      "name_brand_exact_unique",
      0.95,
      nameBrandMatches,
      "After accent and punctuation normalization (and removing a terminal brand suffix), the full product name and brand match exactly and uniquely; any extracted unit and quantity must also agree.",
    );
  }
  if (nameBrandMatches.length > 1) {
    return result(
      "ambiguous",
      "name_brand_exact_unique",
      0,
      nameBrandMatches,
      "The normalized full name, brand, and available package evidence match multiple active products.",
    );
  }
  return result(
    "unmatched",
    null,
    0,
    [],
    "No verified mapping, exact barcode, or unique exact normalized name-and-brand match was found.",
  );
}

export function matchContinenteProduct(
  observation: ContinenteProductObservation,
  catalog: readonly ContinenteCatalogProduct[],
  mappings: ContinenteMappingRepository,
): Promise<ContinenteProductMatch> {
  return matchProduct(observation, catalog, mappings, false);
}

export function matchAuchanProduct(
  observation: ProductMatchObservation,
  catalog: readonly ContinenteCatalogProduct[],
  mappings: ContinenteMappingRepository,
): Promise<ContinenteProductMatch> {
  return matchProduct(observation, catalog, mappings, true);
}