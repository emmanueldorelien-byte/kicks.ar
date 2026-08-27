const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando la carga de datos en Supabase...');

  const products = [
    {
      name: 'Zapatillas Retro Air Max',
      price: 65000,
      category: 'CALZADOS_IMPORTADOS',
      sizes: ['38', '39', '40', '41', '42'],
      colors: ['Negro', 'Blanco'],
      stock: 15,
      imageUrl: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600',
      description: 'Zapatillas deportivas retro de máxima comodidad.',
      shippingMinutes: 45,
      promoType: 'PERCENTAGE',
      discountPercent: 10,
      isHotSale: true,
      isBlackFriday: false,
      isAvailable: true
    },
    {
      name: 'Perfume Importado Eau de Parfum 100ml',
      price: 48000,
      category: 'PERFUMES',
      sizes: ['100ml'],
      colors: ['Único'],
      stock: 10,
      imageUrl: 'https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?w=600',
      description: 'Fragancia duradera y elegante para uso diario u ocasiones especiales.',
      shippingMinutes: 60,
      promoType: 'NONE',
      discountPercent: 0,
      isHotSale: false,
      isBlackFriday: false,
      isAvailable: true
    },
    {
      name: 'Mochila Urbana Impermeable',
      price: 32000,
      category: 'MOCHILAS_CARTERAS',
      sizes: ['Estándar'],
      colors: ['Negro', 'Gris'],
      stock: 20,
      imageUrl: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600',
      description: 'Mochila amplia con compartimento reforzado para notebook.',
      shippingMinutes: 30,
      promoType: 'NONE',
      discountPercent: 0,
      isHotSale: false,
      isBlackFriday: false,
      isAvailable: true
    }
  ];

  // Garantiza que la ejecución espere a que CADA inserción termine en la base de datos
  for (const product of products) {
    const res = await prisma.product.create({ data: product });
    console.log(` Insertado: ${res.name} (ID: ${res.id})`);
  }

  console.log('✅ ¡Todos los productos fueron confirmados en Supabase!');
}

main()
  .catch((e) => {
    console.error('❌ Error al cargar productos:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });