export const PRODUCT_CATEGORIES = [
  'Leite e derivados',
  'Carne',
  'Peixe',
  'Fruta',
  'Legumes',
  'Mercearia',
  'Bebidas',
  'Higiene',
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface DemoProduct {
  readonly id: string;
  readonly name: string;
  readonly brand: string;
  readonly category: ProductCategory;
  readonly unit: string;
  readonly demoPriceCents: number;
  readonly isDemo: true;
}

// Produtos, marcas e preços inventados para demonstração, sem ligação a lojas.
// Os valores são inteiros em cêntimos para evitar erros de arredondamento no total.
export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    id: 'leite-meio-gordo', name: 'Leite meio-gordo', brand: 'Demo Láctea',
    category: 'Leite e derivados', unit: '1L', demoPriceCents: 109, isDemo: true,
  },
  {
    id: 'iogurte-natural', name: 'Iogurte natural', brand: 'Demo Láctea',
    category: 'Leite e derivados', unit: '4 × 125g', demoPriceCents: 169, isDemo: true,
  },
  {
    id: 'queijo-flamengo', name: 'Queijo flamengo', brand: 'Demo Láctea',
    category: 'Leite e derivados', unit: '200g', demoPriceCents: 249, isDemo: true,
  },
  {
    id: 'peito-frango', name: 'Peito de frango', brand: 'Demo Prado',
    category: 'Carne', unit: '500g', demoPriceCents: 399, isDemo: true,
  },
  {
    id: 'bifes-peru', name: 'Bifes de peru', brand: 'Demo Prado',
    category: 'Carne', unit: '500g', demoPriceCents: 449, isDemo: true,
  },
  {
    id: 'carne-picada', name: 'Carne picada de vaca', brand: 'Demo Prado',
    category: 'Carne', unit: '400g', demoPriceCents: 379, isDemo: true,
  },
  {
    id: 'filetes-pescada', name: 'Filetes de pescada', brand: 'Demo Mar',
    category: 'Peixe', unit: '400g', demoPriceCents: 499, isDemo: true,
  },
  {
    id: 'lombos-salmao', name: 'Lombos de salmão', brand: 'Demo Mar',
    category: 'Peixe', unit: '300g', demoPriceCents: 649, isDemo: true,
  },
  {
    id: 'atum-natural', name: 'Atum ao natural', brand: 'Demo Mar',
    category: 'Peixe', unit: '120g', demoPriceCents: 139, isDemo: true,
  },
  {
    id: 'maca-gala', name: 'Maçã Gala', brand: 'Demo Pomar',
    category: 'Fruta', unit: '1kg', demoPriceCents: 199, isDemo: true,
  },
  {
    id: 'banana', name: 'Banana', brand: 'Demo Pomar',
    category: 'Fruta', unit: '1kg', demoPriceCents: 159, isDemo: true,
  },
  {
    id: 'laranja', name: 'Laranja', brand: 'Demo Pomar',
    category: 'Fruta', unit: '1kg', demoPriceCents: 189, isDemo: true,
  },
  {
    id: 'cenoura', name: 'Cenoura', brand: 'Demo Horta',
    category: 'Legumes', unit: '1kg', demoPriceCents: 99, isDemo: true,
  },
  {
    id: 'brocolos', name: 'Brócolos', brand: 'Demo Horta',
    category: 'Legumes', unit: '500g', demoPriceCents: 149, isDemo: true,
  },
  {
    id: 'batata', name: 'Batata', brand: 'Demo Horta',
    category: 'Legumes', unit: '2kg', demoPriceCents: 249, isDemo: true,
  },
  {
    id: 'arroz-agulha', name: 'Arroz agulha', brand: 'Demo Despensa',
    category: 'Mercearia', unit: '1kg', demoPriceCents: 129, isDemo: true,
  },
  {
    id: 'massa-esparguete', name: 'Massa esparguete', brand: 'Demo Despensa',
    category: 'Mercearia', unit: '500g', demoPriceCents: 89, isDemo: true,
  },
  {
    id: 'grao-cozido', name: 'Grão-de-bico cozido', brand: 'Demo Despensa',
    category: 'Mercearia', unit: '400g', demoPriceCents: 79, isDemo: true,
  },
  {
    id: 'agua-natural', name: 'Água natural', brand: 'Demo Fonte',
    category: 'Bebidas', unit: '1,5L', demoPriceCents: 49, isDemo: true,
  },
  {
    id: 'sumo-laranja', name: 'Sumo de laranja', brand: 'Demo Fonte',
    category: 'Bebidas', unit: '1L', demoPriceCents: 179, isDemo: true,
  },
  {
    id: 'cha-frio-pessego', name: 'Chá frio de pêssego', brand: 'Demo Fonte',
    category: 'Bebidas', unit: '1,5L', demoPriceCents: 99, isDemo: true,
  },
  {
    id: 'gel-banho', name: 'Gel de banho', brand: 'Demo Cuidado',
    category: 'Higiene', unit: '500mL', demoPriceCents: 229, isDemo: true,
  },
  {
    id: 'pasta-dentifrica', name: 'Pasta dentífrica', brand: 'Demo Cuidado',
    category: 'Higiene', unit: '75mL', demoPriceCents: 159, isDemo: true,
  },
  {
    id: 'papel-higienico', name: 'Papel higiénico', brand: 'Demo Cuidado',
    category: 'Higiene', unit: '6 rolos', demoPriceCents: 329, isDemo: true,
  },
];