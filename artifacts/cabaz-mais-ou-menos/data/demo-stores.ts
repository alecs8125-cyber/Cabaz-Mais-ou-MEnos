export interface DemoStore {
  readonly id: string;
  readonly name: string;
  readonly isDemo: true;
  readonly demoPricesCents: Readonly<Record<string, number | null>>;
}

type DemoPrice = number | null;
type StorePriceRow = readonly [DemoPrice, DemoPrice, DemoPrice, DemoPrice, DemoPrice];

// Dados inventados e incluídos na aplicação. Nunca representam preços ou stock reais.
// Colunas: Supermercado A, Supermercado B, Supermercado C, Minimercado D, Mercado E.
// Cada valor é o preço, em cêntimos, de uma unidade/embalagem do catálogo.
// null significa que o produto não está disponível nessa loja de demonstração.
const PRICES_BY_PRODUCT: Readonly<Record<string, StorePriceRow>> = {
  'leite-meio-gordo': [99, 119, 109, 129, null],
  'iogurte-natural': [159, 179, 169, 189, null],
  'queijo-flamengo': [239, 259, 249, 269, 229],
  'peito-frango': [379, 409, 399, 429, null],
  'bifes-peru': [439, 429, 459, 479, null],
  'carne-picada': [359, 389, 369, null, null],
  'filetes-pescada': [479, 519, 489, null, 459],
  'lombos-salmao': [619, 649, null, null, 599],
  'atum-natural': [129, 139, 149, 159, null],
  'maca-gala': [189, 209, 199, 219, 169],
  'banana': [149, 169, 159, 179, 139],
  'laranja': [179, 199, 189, 209, 159],
  'cenoura': [89, 109, 99, 119, 79],
  'brocolos': [139, 159, 149, null, 129],
  'batata': [229, 259, 239, 269, 219],
  'arroz-agulha': [129, 139, 149, 159, 119],
  'massa-esparguete': [79, 99, 89, 109, 119],
  'grao-cozido': [69, 89, 79, 99, 59],
  'agua-natural': [45, 55, 49, 59, null],
  'sumo-laranja': [169, 189, 179, 199, null],
  'cha-frio-pessego': [95, 105, 99, 115, null],
  'gel-banho': [219, 209, 229, null, null],
  'pasta-dentifrica': [149, 169, 159, 179, null],
  'papel-higienico': [309, 329, null, 349, null],
};

const STORE_DEFINITIONS = [
  { id: 'supermercado-a', name: 'Supermercado A', column: 0 },
  { id: 'supermercado-b', name: 'Supermercado B', column: 1 },
  { id: 'supermercado-c', name: 'Supermercado C', column: 2 },
  { id: 'minimercado-d', name: 'Minimercado D', column: 3 },
  { id: 'mercado-e', name: 'Mercado E', column: 4 },
] as const;

export const DEMO_STORES: readonly DemoStore[] = STORE_DEFINITIONS.map(({ id, name, column }) => ({
  id,
  name,
  isDemo: true,
  demoPricesCents: Object.fromEntries(
    Object.entries(PRICES_BY_PRODUCT).map(([productId, prices]) => [productId, prices[column]]),
  ),
}));