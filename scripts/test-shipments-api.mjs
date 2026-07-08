import http from 'http';

const body = JSON.stringify({
  batchName: '多门店分Sheet出库单.xlsx',
  originalFileName: '多门店分Sheet出库单.xlsx',
  fileType: 'excel',
  sheetName: '朝阳门店',
  headers: ['朝阳门店出库单', '', '', '', '', '', '', '', '', '', ''],
  mapping: {
    externalCode: null,
    receiverStore: null,
    receiverName: null,
    receiverPhone: null,
    receiverAddress: null,
    skuCode: null,
    skuName: null,
    skuQuantity: null,
    skuSpec: null,
    note: null,
  },
  fingerprint: '朝阳门店::外部编码|sku物品编码|sku物品名称|sku规格型号|sku发货数量|收货门店|收货人姓名|收货人电话|收货人地址|备注|',
  ruleId: '',
  rows: [
    { externalCode: 'CY20241201002', receiverStore: '朝阳门店', receiverName: '张三', receiverPhone: '13800138001', receiverAddress: '北京市朝阳区XX路1号', skuCode: 'SKU001', skuName: '农夫山泉矿泉水', skuQuantity: '10', skuSpec: '550ml*24', note: '', rowIndex: 1, id: '5b36bea0-6a42-47c3-aeae-1395d394610f' },
    { externalCode: 'CY20241201001', receiverStore: '朝阳门店', receiverName: '张三', receiverPhone: '13800138001', receiverAddress: '北京市朝阳区XX路1号', skuCode: 'SKU002', skuName: '康师傅方便面', skuQuantity: '5', skuSpec: '红烧牛肉面5连包', note: '', rowIndex: 2, id: 'dfb8774b-1d1a-4ef6-9376-d92d938d53d2' },
    { externalCode: 'HD20241201001', receiverStore: '海淀门店', receiverName: '李四', receiverPhone: '13900139002', receiverAddress: '北京市海淀区XX路2号', skuCode: 'SKU003', skuName: '可口可乐', skuQuantity: '8', skuSpec: '330ml*24罐', note: '', rowIndex: 3, id: '40a92e9b-3a08-4d00-a8a8-77b5e6eff92c' },
    { externalCode: 'HD20241201001', receiverStore: '海淀门店', receiverName: '李四', receiverPhone: '13900139002', receiverAddress: '北京市海淀区XX路2号', skuCode: 'SKU004', skuName: '金龙鱼调和油', skuQuantity: '3', skuSpec: '5L', note: '', rowIndex: 4, id: '04986e2d-0116-4b85-963c-82020eff1fdd' },
    { externalCode: 'HD20241201001', receiverStore: '海淀门店', receiverName: '李四', receiverPhone: '13900139002', receiverAddress: '北京市海淀区XX路2号', skuCode: 'SKU005', skuName: '蒙牛纯牛奶', skuQuantity: '6', skuSpec: '250ml*24盒', note: '', rowIndex: 5, id: '195ae595-bbd3-4208-b1e9-c9e78d4dd8de' },
    { externalCode: 'XC20241201001', receiverStore: '西城门门店', receiverName: '王五', receiverPhone: '13700137003', receiverAddress: '北京市西城区XX路3号', skuCode: 'SKU006', skuName: '维达纸巾', skuQuantity: '12', skuSpec: '3层*10包', note: '', rowIndex: 6, id: '026146cd-fb88-44f7-8c8c-c8ba811b150e' },
    { externalCode: 'XC20241201001', receiverStore: '西城门门店', receiverName: '王五', receiverPhone: '13700137003', receiverAddress: '北京市西城区XX路3号', skuCode: 'SKU007', skuName: '乐事薯片', skuQuantity: '20', skuSpec: '原味104g', note: '', rowIndex: 7, id: '944cd6a8-b96c-4acb-8910-c2cc3fce5730' },
    { externalCode: 'XC20241201001', receiverStore: '西城门门店', receiverName: '王五', receiverPhone: '13700137003', receiverAddress: '北京市西城区XX路3号', skuCode: 'SKU001', skuName: '农夫山泉矿泉水', skuQuantity: '15', skuSpec: '550ml*24', note: '', rowIndex: 8, id: '1340ee53-641c-4c6f-83a3-097143b40a01' },
  ],
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/universal-import/shipments',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Origin': 'http://localhost:3000',
    'Referer': 'http://localhost:3000/universal-import',
  },
};

console.log('=== 测试本地 API ===');
console.log('Sending POST to:', 'http://' + options.hostname + ':' + options.port + options.path);
console.log('Row count:', JSON.parse(body).rows.length);
console.log('---');

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('---');
    try {
      const parsed = JSON.parse(data);
      console.log('Response:');
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('Response (raw):', data);
    }
  });
});

req.on('error', (e) => {
  console.error('Request Error:', e.message);
});

req.write(body);
req.end();
