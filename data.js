// js/data.js
const EMOTIONS = [
  { id: 'birthday', label: 'Sinh Nhật', emoji: '🎂', description: 'Ghi dấu ngày đặc biệt không thể quên' },
  { id: 'apology', label: 'Xin Lỗi', emoji: '🙏', description: 'Gửi lời xin lỗi từ tận đáy chân thành' },
  { id: 'comfort', label: 'Ủi An', emoji: '🤗', description: 'Cái ôm ấm áp gói gọn trong hộp' },
  { id: 'exam_support', label: 'Tiếp Sức', emoji: '📚', description: 'Cổ vũ tinh thần vượt qua áp lực' },
  { id: 'thank_you', label: 'Cảm Ơn', emoji: '💛', description: 'Thể hiện lòng biết ơn chân thật' },
  { id: 'celebration', label: 'Ăn Mừng', emoji: '🎉', description: 'Bật tung cảm xúc vui vẻ!' },
  { id: 'breakup_comfort', label: 'Chữa Lành', emoji: '💔', description: 'Nhắc nhở rằng họ luôn được yêu thương' },
  { id: 'other', label: 'Bất Ngờ', emoji: '✨', description: 'Đôi khi không cần lý do' },
];

const FEATURED_BOXES = [
  {
    id: 'box-basic-love',
    name: 'Gói Basic Tình Yêu',
    tagline: 'Món quà ngọt ngào',
    image: '2. Basic Valentine.png',
    price: 199000,
    badge: 'Bán Chạy Nhất',
    desc: 'Thể hiện tình cảm chân thành với nửa kia qua những món đồ nhỏ xinh nhưng đầy ý nghĩa.'
  },
  {
    id: 'box-basic-healing',
    name: 'Gói Basic Chữa Lành',
    tagline: 'Xoa dịu tâm hồn',
    image: '2. Basic Healing.png',
    price: 199000,
    badge: 'Healing',
    desc: 'Một bộ sưu tập ấm áp được thiết kế để xoa dịu tâm hồn và trao tặng một cái ôm tinh thần.'
  },
  {
    id: 'box-basic-support',
    name: 'Gói Basic Động Viên',
    tagline: 'Luôn bên cạnh bạn',
    image: '2. Basic Support.png',
    price: 199000,
    badge: 'Phổ Biến',
    desc: 'Món quà khích lệ tinh thần tuyệt vời nhất dành cho những lúc họ cần một bờ vai để tựa vào.'
  },
  {
    id: 'box-basic-motivation',
    name: 'Gói Basic Tiếp Sức',
    tagline: 'Nạp năng lượng tức thì',
    image: '2. Basic Motivation.png',
    price: 199000,
    badge: 'Trending',
    desc: 'Mọi thứ bạn cần để thức xuyên đêm chạy deadline hay những kỳ thi căng thẳng nhất.'
  },
  {
    id: 'box-basic-celebration',
    name: 'Gói Basic Ăn Mừng',
    tagline: 'Bật tung cảm xúc',
    image: '2. Basic Celebration.png',
    price: 199000,
    badge: 'Mới Nhất',
    desc: 'Cùng chia sẻ niềm vui và chúc mừng những cột mốc đáng nhớ trong cuộc sống.'
  },
  {
    id: 'box-basic-sorry',
    name: 'Gói Basic Xin Lỗi',
    tagline: 'Làm hòa nhé',
    image: '2. Basic Sorry.png',
    price: 199000,
    badge: 'Hot',
    desc: 'Gửi gắm lời xin lỗi từ tận đáy lòng để gắn kết lại những rạn nứt một cách tự nhiên nhất.'
  }
];

function formatPrice(price) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(price);
}
