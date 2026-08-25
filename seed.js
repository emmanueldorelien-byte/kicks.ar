const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const products = [
    {
      name: 'Zapatillas Retro Air Max',
      price: 65000,
      sizes: [38, 39, 40, 41, 42],
      colors: ['Negro', 'Blanco'],
      stock: 15,
      imageUrl: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600',
      description: 'Zapatillas deportivas retro de máxima comodidad.',
      shippingMinutes: 45,
      promoType: 'PERCENTAGE',
      discountPercent: 10,
      isHotSale: true,
      isBlackFriday: false
    },
    {
      name: 'Urban Street Black',
      price: 52000,
      sizes: [39, 40, 41, 42, 43],
      colors: ['Negro', 'Gris'],
      stock: 20,
      imageUrl: 'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=600',
      description: 'Estilo urbano para todos los días.',
      shippingMinutes: 60,
      promoType: 'TWO_FOR_ONE',
      discountPercent: 0,
      isHotSale: false,
      isBlackFriday: true
    },
    {
      name: 'Runner Pro Response',
      price: 78000,
      sizes: [37, 38, 39, 40],
      colors: ['Azul', 'Rosa', 'Blanco'],
      stock: 10,
      imageUrl: 'https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2?w=600',
      description: 'Especiales para alto rendimiento y running.',
      shippingMinutes: 30,
      promoType: 'NONE',
      discountPercent: 0,
      isHotSale: false,
      isBlackFriday: false
    }
  ];

  for (const product of products) {
    await prisma.product.create({ data: product });
  }

  console.log('✅ ¡Productos de prueba cargados correctamente!');
}

main()
  .catch((e) => {
    console.error('❌ Error al cargar productos:', e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });