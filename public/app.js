function comprarPorWhatsApp(productoId, productoNombre) {
  const numeroWhatsApp = "5493518685045"; // Tu número con código de país
  const mensaje = encodeURIComponent(`Hola! quiero comprar el producto: ${productoNombre} (ID: ${productoId})`);
  
  window.open(`https://wa.me/${numeroWhatsApp}?text=${mensaje}`, '_blank');
}