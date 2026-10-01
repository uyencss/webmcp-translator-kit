// Local, deterministic screenshot fixture. No external provider or credentials.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./demo-page.html', import.meta.url));
const translations = new Map([
  ['晨光 · 科学笔记', 'Ánh ban mai · Ghi chép khoa học'],
  ['演示文章 · 不包含个人信息', 'Bài viết minh họa · Không chứa thông tin cá nhân'],
  ['自然观察 / 科学阅读', 'Quan sát thiên nhiên / Đọc khoa học'],
  ['城市里的小花园，正在改变我们理解自然的方式', 'Những khu vườn nhỏ trong thành phố đang thay đổi cách chúng ta hiểu về thiên nhiên'],
  ['即使在繁忙的街区，一片小小的绿色空间也能成为观察季节变化的窗口。', 'Ngay cả giữa khu phố nhộn nhịp, một khoảng xanh nhỏ cũng giúp ta quan sát sự thay đổi của các mùa.'],
  ['从一平方米开始', 'Bắt đầu từ một mét vuông'],
  ['一座社区花园不需要很大的面积。几株本地植物、充足的阳光和定期浇水，就能吸引昆虫和鸟类来到这里。', 'Một khu vườn cộng đồng không cần nhiều diện tích. Vài loài cây bản địa, đủ ánh nắng và tưới nước đều đặn đã có thể thu hút côn trùng cùng chim chóc.'],
  ['志愿者每周记录花朵开放的时间，并比较不同月份的变化。这些简单的观察帮助人们理解天气、植物和城市生活之间的联系。', 'Mỗi tuần, các tình nguyện viên ghi lại thời điểm hoa nở và so sánh sự thay đổi giữa các tháng. Những quan sát giản dị này giúp mọi người hiểu mối liên hệ giữa thời tiết, cây cối và đời sống đô thị.'],
  ['当邻居们分享种植经验时，花园也成为交流知识的公共空间。孩子可以在这里学习观察、提问和照顾身边的环境。', 'Khi hàng xóm chia sẻ kinh nghiệm trồng cây, khu vườn trở thành không gian trao đổi kiến thức. Trẻ em có thể học cách quan sát, đặt câu hỏi và chăm sóc môi trường quanh mình.']
]);

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  if (req.method === 'GET' && path === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'store-demo-sse' }] }));
    return;
  }
  if (req.method !== 'POST' || path !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const items = JSON.parse(input.messages.find((message) => message.role === 'user').content);
    const results = items.map(({ id, revision, text }) => ({
      id,
      revision,
      text: translations.get(text) ?? text
    }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ model: 'store-demo-sse', choices: [{ delta: { content: '{"results":[' } }] })}\n\n`);
    for (const [index, result] of results.entries()) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      const content = JSON.stringify(result) + (index + 1 < results.length ? ',' : '');
      res.write(`data: ${JSON.stringify({ model: 'store-demo-sse', choices: [{ delta: { content } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ model: 'store-demo-sse', choices: [{ delta: { content: ']}' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch {
    res.writeHead(400).end();
  }
});

server.listen(8097, '127.0.0.1', () => {
  process.stdout.write('Screenshot demo: http://127.0.0.1:8097/\n');
});
