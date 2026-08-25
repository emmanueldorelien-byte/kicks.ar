# 👟 KICKS.ar | Tienda Multirrubro & Bot de WhatsApp Automático

Plataforma e-commerce full-stack diseñada para la venta multirrubro con catálogo web dinámico, autenticación de usuarios, panel administrativo, métricas de ventas, integración con WhatsApp Web para toma de pedidos en tiempo real y generación automática de comprobantes en PDF.

---

## 🚀 Características Principales

### 🛒 Tienda Web (Frontend)
- **Catálogo Interactivo:** Filtrado multirrubro por categorías (Perfumes, Moda, Calzados Importados, Tecnología, Bazar, etc.).
- **Diseño Responsive & Moderno:** Construido con **Tailwind CSS** e **Icons de Lucide**.
- **Carrusel Promocional Marquee:** Muestra dinámica de productos destacados, ofertas 2x1, Hot Sale y Black Friday.
- **Visualizador Multimedia:** Soporte para galerías de imágenes múltiples y videos con efecto zoom en hover y modal Lightbox interactivo.
- **Integración con WhatsApp:** Redirección inteligente del usuario al bot con sus preferencias de talle, color y datos de sesión web.
- **Beneficios Destacados:** Indicador visual de **Envío Gratis en Córdoba Capital** y envíos al resto del país en 48 hs.
- **Historial de Compras:** Panel para el cliente donde puede consultar sus órdenes realizadas y descargar los comprobantes PDF.

### 🤖 Bot de WhatsApp (Backend)
- **Motor Automático:** Integrado mediante `whatsapp-web.js` con persistencia de sesión local (`LocalAuth`).
- **Asistente Virtual (Luci):** Muestra el producto, verifica stock, talle, variantes de color y consolida el carrito de compras.
- **Flujo de Logística y Pago:** Recopila dirección de entrega, destinatario, modalidad de envío (prioritaria o programada) y medios de pago (Mercado Pago, PayPal, Transferencia y Efectivo contra entrega con seña del 20%).
- **Gestión de Comprobantes:** Recepción automática de fotos de transferencia/seña, actualización del estado a `PAYMENT_IN_REVIEW` y envío automático del PDF firmado.
- **Control de Inactividad:** Detección de sesiones pausadas con alertas automáticas para retomar o anular el pedido.

### ⚙️ Panel Administrador
- **Gestión de Productos (CRUD):** Creación, edición, borrado y alternado de disponibilidad de productos.
- **Subida de Archivos:** Carga de imágenes y videos locales mediante `Multer`.
- **Aprobación de Comprobantes:** Aprobación o rechazo de pagos con notificación instantánea al cliente vía WhatsApp.
- **Métricas de Venta:** Mapeo de ventas y facturación diaria y mensual.

---

## 🛠️ Tecnologías Utilizadas

- **Servidor:** Node.js, Express.js
- **Base de Datos & ORM:** PostgreSQL (Neon / Supabase), Prisma ORM
- **Automatización WhatsApp:** `whatsapp-web.js`, Puppeteer, QRCode Terminal
- **Documentos & Archivos:** PDFKit, Multer, Bcrypt.js
- **Estilos & UI:** Tailwind CSS, Lucide Icons

---

## 📁 Estructura del Proyecto

```text
tienda/
├── public/
│   ├── index.html         # Portal de la tienda para clientes
│   ├── admin.html         # Panel de administración
│   └── uploads/           # Almacenamiento de archivos multimedia
├── prisma/
│   └── schema.prisma      # Esquema de la base de datos (PostgreSQL)
├── server.js              # Servidor principal API REST & Bot de WhatsApp
├── package.json           # Dependencias del proyecto
└── .env                   # Variables de entorno