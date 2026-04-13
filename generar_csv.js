import fs from 'fs';

const CANTIDAD = 3000;
let csvContent = 'codigo_barras,nombre,precio_actual,stock,activo\n';

for (let i = 1; i <= CANTIDAD; i++) {
  const codigo_barras = `779000${String(i).padStart(6, '0')}`; 
  const nombre = `Producto Prueba ${i}`;
  const precio_actual = (Math.random() * (10000 - 100) + 100).toFixed(2);
  const stock = Math.floor(Math.random() * 500);
  
  csvContent += `${codigo_barras},${nombre},${precio_actual},${stock},true\n`;
}

fs.writeFileSync('productos_test_3000.csv', csvContent, 'utf8');
console.log(`¡Éxito! Se generó el archivo productos_test_3000.csv con ${CANTIDAD} productos.`);