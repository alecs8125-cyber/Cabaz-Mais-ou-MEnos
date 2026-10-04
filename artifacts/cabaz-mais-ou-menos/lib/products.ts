import { DEMO_PRODUCTS, type DemoProduct } from '../data/demo-products';

const productsById = new Map(DEMO_PRODUCTS.map((product) => [product.id, product]));
const euros = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-PT')
    .trim()
    .replace(/\s+/g, ' ');
}

export function searchProducts(query: string): readonly DemoProduct[] {
  const name = normalizeName(query);
  return name
    ? DEMO_PRODUCTS.filter((product) => normalizeName(product.name).includes(name))
    : DEMO_PRODUCTS;
}

export function getDemoProduct(id: string): DemoProduct {
  const product = productsById.get(id);
  if (!product) throw new Error('Produto de demonstração desconhecido.');
  return product;
}

export function formatDemoPrice(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('O preço de demonstração tem de ser um número inteiro de cêntimos.');
  }
  return euros.format(cents / 100);
}