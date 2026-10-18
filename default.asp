<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CITFUND ENTERPRISE | Empowering Futures, Building Wealth</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    
    <style>
        :root {
            /* ===== CITFUND ENTERPRISE BRAND COLORS ===== */
            --green: #0B7A2E;
            --green-dark: #075C22;
            --green-light: #14A344;
            --gold: #FFC72C;
            --gold-soft: #FFD75E;
            --red: #E30613;

            /* ===== NEUTRALS ===== */
            --white: #ffffff;
            --light-bg: #f4f9f6;
            --text-dark: #1a2b4c;
            --text-muted: #6b7a8f;
            --danger: #e74c3c;
            --success: #00a86b;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Poppins', sans-serif; }
        body { overflow-x: hidden; color: var(--text-dark); background: var(--light-bg); }
        img, video { max-width: 100%; display: block; }
        
        /* ===== 1. NAVIGATION ===== */
        .navbar {
            position: fixed; top: 0; width: 100%; z-index: 1000;
            background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(12px);
            border-bottom: 1px solid #e6f0e9;
            display: flex; justify-content: space-between; align-items: center;
            padding: 14px 40px; transition: all 0.3s ease;
        }
        .logo { display: flex; align-items: center; gap: 12px; }
        .logo-icon {
            width: 45px; height: 45px;
            background: linear-gradient(135deg, var(--green), var(--green-light));
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            color: white; font-size: 22px;
            box-shadow: 0 6px 18px rgba(11,122,46,0.3);
        }
        .logo-text h2 { font-size: 20px; color: var(--green); font-weight: 800; letter-spacing: 1px; }
        .logo-text h2 span { color: var(--gold); }
        .logo-text p { font-size: 9px; letter-spacing: 2.5px; color: var(--text-muted); font-weight: 600; }
        
        .nav-links { display: flex; gap: 30px; align-items: center; }
        .nav-links a { text-decoration: none; color: var(--text-dark); font-weight: 500; transition: 0.3s; font-size: 15px; }
        .nav-links a:hover { color: var(--green); }
        
        .login-btn {
            background: transparent;
            border: 2px solid var(--green);
            color: var(--green);
            padding: 8px 22px; border-radius: 30px;
            font-weight: 700; text-decoration: none;
            transition: 0.3s;
        }
        .login-btn:hover {
            background: var(--green);
            color: white;
            box-shadow: 0 8px 20px rgba(11,122,46,0.3);
        }
        
        .menu-toggle { display: none; background: none; border: none; font-size: 24px; color: var(--green); cursor: pointer; }
        
        /* ===== 2. HERO SECTION with welcome_video.mp4 ===== */
        .hero {
            position: relative; min-height: 100vh;
            display: flex; align-items: center; justify-content: center; text-align: center;
            color: white; padding: 130px 20px 100px;
            overflow: hidden;
        }
        .hero-video {
            position: absolute;
            top: 50%; left: 50%;
            min-width: 100%; min-height: 100%;
            width: auto; height: auto;
            transform: translate(-50%, -50%);
            object-fit: cover;
            z-index: 0;
        }
        .hero-overlay {
            position: absolute; inset: 0;
            background: linear-gradient(135deg, rgba(7,92,34,0.85) 0%, rgba(11,122,46,0.72) 50%, rgba(6,24,61,0.88) 100%);
            z-index: 1;
        }
        .hero-content {
            position: relative; z-index: 2;
            max-width: 900px;
            animation: fadeInUp 1s ease;
        }
        .hero-badge {
            display: inline-flex; align-items: center; gap: 8px;
            background: rgba(255,199,44,0.18);
            border: 1px solid rgba(255,199,44,0.5);
            color: var(--gold);
            padding: 8px 18px; border-radius: 30px;
            font-size: 13px; font-weight: 600;
            letter-spacing: 0.5px;
            margin-bottom: 25px;
            backdrop-filter: blur(10px);
        }
        .hero h1 { font-size: 62px; font-weight: 900; line-height: 1.12; margin-bottom: 22px; letter-spacing: -1.2px; }
        .hero h1 span { color: var(--gold); }
        .hero p { font-size: 18px; color: #e6f0e9; margin-bottom: 35px; line-height: 1.7; max-width: 720px; margin-left: auto; margin-right: auto; }
        .hero-buttons { display: flex; gap: 18px; justify-content: center; flex-wrap: wrap; }
        .btn-gold {
            background: linear-gradient(135deg, var(--gold), var(--gold-soft));
            color: var(--green-dark);
            padding: 16px 40px; border-radius: 50px;
            text-decoration: none; font-weight: 800; font-size: 16px;
            box-shadow: 0 10px 30px rgba(255,199,44,0.45);
            transition: 0.3s;
            display: inline-flex; align-items: center; gap: 10px;
            border: none; cursor: pointer;
        }
        .btn-gold:hover { transform: translateY(-3px); box-shadow: 0 15px 40px rgba(255,199,44,0.6); }
        .btn-outline {
            background: transparent;
            border: 2px solid white; color: white;
            padding: 16px 40px; border-radius: 50px;
            text-decoration: none; font-weight: 600; font-size: 16px;
            transition: 0.3s;
        }
        .btn-outline:hover { background: white; color: var(--green); }
        
        /* Scroll hint */
        .scroll-hint {
            position: absolute;
            bottom: 30px; left: 50%;
            transform: translateX(-50%);
            color: rgba(255,255,255,0.7);
            font-size: 22px;
            z-index: 2;
            animation: bounce 2s infinite;
        }
        @keyframes bounce {
            0%, 100% { transform: translateX(-50%) translateY(0); }
            50% { transform: translateX(-50%) translateY(10px); }
        }
        
        /* ===== 3. FEATURES ===== */
        .section-title { text-align: center; margin-bottom: 60px; padding: 0 20px; }
        .section-title h3 { font-size: 38px; color: var(--green); font-weight: 800; line-height: 1.2; }
        .section-title h3 span { color: var(--gold); }
        .section-title p { color: var(--text-muted); max-width: 700px; margin: 14px auto 0; line-height: 1.7; font-size: 16px; }
        
        .features { display: grid; grid-template-columns: repeat(4, 1fr); gap: 30px; padding: 90px 8%; background: var(--white); }
        .feature-card {
            text-align: center; padding: 35px 25px;
            border-radius: 20px;
            transition: 0.4s;
            border: 1px solid transparent;
        }
        .feature-card:hover {
            transform: translateY(-10px);
            box-shadow: 0 20px 40px rgba(11,122,46,0.08);
            background: var(--light-bg);
            border-color: rgba(11,122,46,0.1);
        }
        .feature-icon {
            width: 80px; height: 80px;
            margin: 0 auto 20px;
            border-radius: 24px;
            background: linear-gradient(135deg, rgba(11,122,46,0.1), rgba(255,199,44,0.15));
            display: flex; align-items: center; justify-content: center;
            font-size: 34px;
            color: var(--green);
            transition: 0.4s;
        }
        .feature-card:hover .feature-icon {
            background: linear-gradient(135deg, var(--green), var(--green-light));
            color: white;
            transform: scale(1.08) rotate(-3deg);
            box-shadow: 0 12px 25px rgba(11,122,46,0.3);
        }
        .feature-card h4 { font-size: 18px; margin-bottom: 10px; color: var(--green); font-weight: 700; }
        .feature-card p { font-size: 14px; color: var(--text-muted); line-height: 1.6; }
        
        /* ===== 4. ABOUT ===== */
        .about { padding: 90px 8%; display: grid; grid-template-columns: 1fr 1fr; gap: 60px; align-items: center; }
        .about-image { position: relative; }
        .about-image img { width: 100%; border-radius: 24px; box-shadow: 0 25px 60px rgba(11,122,46,0.15); }
        .about-image::after {
            content: '';
            position: absolute;
            bottom: -20px; right: -20px;
            width: 120px; height: 120px;
            background: var(--gold);
            border-radius: 24px;
            z-index: -1;
            opacity: 0.3;
        }
        .about-text h3 { font-size: 38px; color: var(--green); margin-bottom: 20px; font-weight: 800; line-height: 1.2; }
        .about-text h3 span { color: var(--gold); }
        .about-text p { color: var(--text-muted); line-height: 1.8; margin-bottom: 22px; }
        .check-list { list-style: none; }
        .check-list li { margin-bottom: 14px; display: flex; align-items: center; gap: 12px; color: var(--text-dark); font-weight: 500; }
        .check-list li i { color: var(--green); font-size: 20px; flex-shrink: 0; }
        
        /* ===== 5. APP SHOWCASE (Phone_cit.png + manage_your_money.mp4) ===== */
        .app-showcase {
            padding: 100px 8%;
            background: linear-gradient(160deg, #e8f5ec 0%, #d4ebda 50%, #eaf6ee 100%);
            position: relative;
            overflow: hidden;
        }
        .app-showcase::before {
            content: '';
            position: absolute;
            top: -150px; right: -150px;
            width: 400px; height: 400px;
            background: radial-gradient(circle, rgba(255,199,44,0.25), transparent 70%);
            border-radius: 50%;
        }
        .app-showcase::after {
            content: '';
            position: absolute;
            bottom: -150px; left: -150px;
            width: 500px; height: 500px;
            background: radial-gradient(circle, rgba(11,122,46,0.15), transparent 70%);
            border-radius: 50%;
        }
        .app-showcase-inner {
            position: relative; z-index: 2;
            max-width: 1200px;
            margin: 0 auto;
            display: grid;
            grid-template-columns: 1fr 1.1fr;
            gap: 70px;
            align-items: center;
        }
        
        /* Phone image side */
        .phone-side {
            position: relative;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 500px;
        }
        .phone-glow {
            position: absolute;
            inset: 0;
            margin: auto;
            width: 320px; height: 320px;
            background: radial-gradient(circle, rgba(255,199,44,0.4), transparent 70%);
            border-radius: 50%;
            filter: blur(20px);
            z-index: 0;
        }
        .phone-img {
            position: relative;
            z-index: 2;
            width: 100%;
            max-width: 340px;
            height: auto;
            filter: drop-shadow(0 30px 60px rgba(11,122,46,0.35));
            animation: floatPhone 4s ease-in-out infinite;
        }
        @keyframes floatPhone {
            0%, 100% { transform: translateY(0) rotate(-1deg); }
            50% { transform: translateY(-18px) rotate(1deg); }
        }
        /* Floating decoration badges */
        .float-badge {
            position: absolute;
            background: white;
            border-radius: 16px;
            padding: 12px 16px;
            box-shadow: 0 15px 35px rgba(11,122,46,0.15);
            display: flex; align-items: center; gap: 10px;
            font-size: 13px; font-weight: 700;
            color: var(--green);
            z-index: 3;
            animation: floatBadge 5s ease-in-out infinite;
        }
        .float-badge i {
            width: 32px; height: 32px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 14px; color: white;
        }
        .float-badge.badge-1 { top: 12%; left: 0; }
        .float-badge.badge-1 i { background: linear-gradient(135deg, var(--green), var(--green-light)); }
        .float-badge.badge-2 { bottom: 15%; right: 0; animation-delay: 1s; }
        .float-badge.badge-2 i { background: linear-gradient(135deg, var(--gold), #ffb400); color: var(--green-dark); }
        .float-badge.badge-3 { top: 45%; right: -5%; animation-delay: 2s; }
        .float-badge.badge-3 i { background: linear-gradient(135deg, var(--red), #ff4757); }
        @keyframes floatBadge {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-10px); }
        }
        
        /* Video content side */
        .app-text-side h3 {
            font-size: 38px; font-weight: 800;
            color: var(--green); line-height: 1.2;
            margin-bottom: 18px;
        }
        .app-text-side h3 span { color: var(--gold); }
        .app-text-side > p {
            color: var(--text-muted); line-height: 1.8;
            margin-bottom: 28px; font-size: 16px;
        }
        .app-features-list {
            display: grid; grid-template-columns: 1fr 1fr;
            gap: 12px 20px; margin-bottom: 30px;
        }
        .app-features-list div {
            display: flex; align-items: center; gap: 10px;
            font-size: 14px; font-weight: 600; color: var(--text-dark);
        }
        .app-features-list i { color: var(--green); font-size: 16px; }
        
        /* Video preview card */
        .money-video-card {
            border-radius: 20px;
            overflow: hidden;
            box-shadow: 0 25px 55px rgba(11,122,46,0.25);
            border: 4px solid white;
            background: #000;
            position: relative;
            max-width: 100%;
        }
        .money-video-card video {
            width: 100%; height: auto; display: block;
        }
        .money-video-card .video-label {
            position: absolute;
            top: 14px; left: 14px;
            background: rgba(11,122,46,0.9);
            color: white;
            font-size: 11px; font-weight: 700;
            padding: 6px 14px; border-radius: 20px;
            letter-spacing: 0.5px;
            backdrop-filter: blur(10px);
            display: flex; align-items: center; gap: 6px;
        }
        .money-video-card .video-label i { color: var(--gold); font-size: 10px; }
        
        /* ===== 6. VIDEO SECTION (cit_advert_video.mp4) ===== */
        .video-section {
            padding: 90px 8%;
            background: var(--white);
            text-align: center;
        }
        .video-wrapper {
            max-width: 900px;
            margin: 0 auto;
            border-radius: 24px;
            overflow: hidden;
            box-shadow: 0 30px 70px rgba(11,122,46,0.25);
            border: 4px solid white;
            position: relative;
            background: #000;
        }
        .video-wrapper video { width: 100%; height: auto; display: block; }
        
        /* ===== 7. STATS ===== */
        .stats {
            background: linear-gradient(135deg, var(--green) 0%, var(--green-dark) 100%);
            padding: 70px 8%;
            display: grid; grid-template-columns: repeat(4, 1fr); gap: 30px;
            text-align: center; color: white;
            position: relative;
            overflow: hidden;
        }
        .stats::before {
            content: '';
            position: absolute;
            top: -50%; right: -10%;
            width: 400px; height: 400px;
            background: radial-gradient(circle, rgba(255,199,44,0.15), transparent 70%);
            border-radius: 50%;
        }
        .stat-box { position: relative; z-index: 2; }
        .stat-box h3 { font-size: 50px; font-weight: 900; color: var(--gold); letter-spacing: -1px; }
        .stat-box p { font-size: 16px; color: rgba(255,255,255,0.85); font-weight: 500; margin-top: 5px; }
        
        /* ===== 8. SECURITY ===== */
        .security { padding: 90px 8%; background: var(--white); display: grid; grid-template-columns: 1fr 1fr; gap: 60px; align-items: center; }
        .security-text h3 { font-size: 38px; color: var(--green); margin-bottom: 20px; font-weight: 800; line-height: 1.2; }
        .security-text h3 span { color: var(--gold); }
        .security-text p { color: var(--text-muted); line-height: 1.8; }
        .security-icons { display: flex; gap: 20px; margin-top: 30px; }
        .sec-icon {
            width: 62px; height: 62px;
            background: linear-gradient(135deg, rgba(11,122,46,0.1), rgba(255,199,44,0.2));
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            color: var(--green); font-size: 24px;
            transition: 0.3s;
        }
        .sec-icon:hover {
            background: linear-gradient(135deg, var(--green), var(--green-light));
            color: white;
            transform: translateY(-5px);
            box-shadow: 0 12px 25px rgba(11,122,46,0.3);
        }
        .security-image img { width: 100%; border-radius: 24px; box-shadow: 0 25px 60px rgba(11,122,46,0.15); }
        
        /* ===== 9. CTA ===== */
        .cta {
            background: linear-gradient(135deg, rgba(11,122,46,0.95), rgba(7,92,34,0.95)),
                url('https://images.unsplash.com/photo-1563986768609-322da13575f3?q=80&w=1200&auto=format&fit=crop');
            background-size: cover; background-position: center;
            padding: 80px 8%; text-align: center;
            color: white;
        }
        .cta h3 { font-size: 38px; color: white; margin-bottom: 18px; font-weight: 800; }
        .cta h3 span { color: var(--gold); }
        .cta p { color: rgba(255,255,255,0.9); margin-bottom: 32px; font-size: 17px; }
        
        /* ===== 10. FOOTER ===== */
        .footer { background: var(--green-dark); color: white; padding: 60px 8% 20px; }
        .footer-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 40px; margin-bottom: 40px; }
        .footer-grid h4 { margin-bottom: 20px; font-size: 17px; color: var(--gold); font-weight: 700; letter-spacing: 0.5px; }
        .footer-grid a { color: rgba(255,255,255,0.75); text-decoration: none; display: block; margin-bottom: 12px; transition: 0.3s; font-size: 14px; }
        .footer-grid a:hover { color: var(--gold); transform: translateX(3px); }
        .footer-grid a i { margin-right: 8px; color: var(--gold); }
        .copyright { text-align: center; border-top: 1px solid rgba(255,255,255,0.12); padding-top: 22px; font-size: 14px; color: rgba(255,255,255,0.7); }
        .copyright span { color: var(--gold); font-weight: 600; }
        
        /* ===== RESPONSIVE ===== */
        @media (max-width: 1024px) {
            .app-showcase-inner { gap: 50px; }
            .app-text-side h3 { font-size: 32px; }
        }
        @media (max-width: 900px) {
            .navbar { padding: 14px 20px; }
            .nav-links { display: none; }
            .menu-toggle { display: block; }
            .hero h1 { font-size: 42px; }
            .hero p { font-size: 15px; }
            .features { grid-template-columns: repeat(2, 1fr); padding: 60px 20px; gap: 20px; }
            .about, .security { grid-template-columns: 1fr; padding: 60px 20px; gap: 40px; }
            .about-image { order: -1; }
            .video-section { padding: 60px 20px; }
            .app-showcase { padding: 70px 20px; }
            .app-showcase-inner { grid-template-columns: 1fr; gap: 50px; }
            .phone-side { min-height: 420px; }
            .phone-img { max-width: 280px; }
            .float-badge { font-size: 12px; padding: 10px 14px; }
            .float-badge.badge-3 { display: none; }
            .app-features-list { grid-template-columns: 1fr; }
            .app-text-side { text-align: center; }
            .app-text-side h3 { font-size: 28px; }
            .app-features-list div { justify-content: center; }
            .stats { grid-template-columns: repeat(2, 1fr); padding: 50px 20px; gap: 25px; }
            .stat-box h3 { font-size: 38px; }
            .footer-grid { grid-template-columns: repeat(2, 1fr); }
            .section-title h3 { font-size: 28px; }
            .about-text h3, .security-text h3 { font-size: 28px; }
            .cta h3 { font-size: 28px; }
        }
        @media (max-width: 480px) {
            .hero { padding: 110px 16px 80px; }
            .hero h1 { font-size: 32px; }
            .hero-badge { font-size: 11px; padding: 6px 14px; }
            .hero-buttons { flex-direction: column; align-items: stretch; }
            .btn-gold, .btn-outline { justify-content: center; text-align: center; padding: 15px 30px; font-size: 15px; }
            .features { grid-template-columns: 1fr; }
            .feature-card { padding: 28px 20px; }
            .phone-img { max-width: 240px; }
            .phone-side { min-height: 340px; }
            .float-badge { font-size: 11px; padding: 8px 12px; gap: 8px; }
            .float-badge i { width: 26px; height: 26px; font-size: 12px; }
            .float-badge.badge-1 { top: 8%; left: -5px; }
            .float-badge.badge-2 { bottom: 10%; right: -5px; }
            .app-text-side h3 { font-size: 24px; }
            .stat-box h3 { font-size: 32px; }
            .stat-box p { font-size: 13px; }
        }
        
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }
    </style>
</head>
<body>

<!-- 1. NAVBAR -->
<nav class="navbar">
    <div class="logo">
        <div class="logo-icon"><i class="fa-solid fa-building-columns"></i></div>
        <div class="logo-text">
            <h2>CIT<span>FUND</span></h2>
            <p>ENTERPRISE</p>
        </div>
    </div>
    <div class="nav-links">
        <a href="#home">Home</a>
        <a href="#services">Services</a>
        <a href="#app">Mobile App</a>
        <a href="#about">About</a>
        <a href="#security">Security</a>
        <a href="userlogin.html" class="login-btn">Login</a>
    </div>
    <button class="menu-toggle"><i class="fa-solid fa-bars"></i></button>
</nav>

<!-- 2. HERO with welcome_video.mp4 background -->
<section class="hero" id="home">
    <video class="hero-video" autoplay muted loop playsinline preload="auto">
        <source src="welcome_video.mp4" type="video/mp4">
    </video>
    <div class="hero-overlay"></div>
    <div class="hero-content">
        <div class="hero-badge">
            <i class="fa-solid fa-shield-halved"></i>
            <span>Your Trusted Financial Partner</span>
        </div>
        <h1>Empowering Futures,<br><span>Building Wealth</span></h1>
        <p>Join thousands of satisfied customers using the most secure and reliable digital banking platform in Ghana. Your trust, our priority.</p>
        <div class="hero-buttons">
            <a href="selfaccountopen.html" class="btn-gold">
                Open an Account <i class="fa-solid fa-arrow-right"></i>
            </a>
            <a href="userlogin.html" class="btn-outline">Sign In</a>
        </div>
    </div>
    <a href="#services" class="scroll-hint"><i class="fa-solid fa-chevron-down"></i></a>
</section>

<!-- 3. FEATURES -->
<section class="features" id="services">
    <div class="feature-card">
        <div class="feature-icon"><i class="fa-solid fa-shield-halved"></i></div>
        <h4>Bank-Grade Security</h4>
        <p>256-bit AES encryption and SSL protocols to keep your money safe.</p>
    </div>
    <div class="feature-card">
        <div class="feature-icon"><i class="fa-solid fa-bolt"></i></div>
        <h4>Instant Transfers</h4>
        <p>Send money to any CIT account instantly with zero delay.</p>
    </div>
    <div class="feature-card">
        <div class="feature-icon"><i class="fa-solid fa-headset"></i></div>
        <h4>24/7 Support</h4>
        <p>Our customer support team is always available to assist you.</p>
    </div>
    <div class="feature-card">
        <div class="feature-icon"><i class="fa-solid fa-chart-line"></i></div>
        <h4>Smart Investment</h4>
        <p>Grow your wealth with our high-yield savings plans.</p>
    </div>
</section>

<!-- 4. ABOUT -->
<section class="about" id="about">
    <div class="about-image">
        <img src="https://images.unsplash.com/photo-1521791136064-7986c2920216?q=80&w=1200&auto=format&fit=crop" alt="Banking">
    </div>
    <div class="about-text">
        <h3>Your Trusted <span>Financial Partner</span></h3>
        <p>At CITFUND ENTERPRISE, we understand that your money represents your hard work, dreams, and future. We are dedicated to providing a seamless, transparent, and secure banking experience for everyone.</p>
        <ul class="check-list">
            <li><i class="fa-solid fa-circle-check"></i> 100% Secure and Confidential</li>
            <li><i class="fa-solid fa-circle-check"></i> Fast and Reliable Digital Banking</li>
            <li><i class="fa-solid fa-circle-check"></i> No Hidden Charges</li>
            <li><i class="fa-solid fa-circle-check"></i> Empowering Financial Freedom</li>
        </ul>
    </div>
</section>

<!-- 5. APP SHOWCASE — Phone_cit.png + manage_your_money.mp4 -->
<section class="app-showcase" id="app">
    <div class="app-showcase-inner">
        
        <!-- Left: Phone image with floating badges -->
        <div class="phone-side">
            <div class="phone-glow"></div>
            <img src="Phone_cit.png" alt="CITFUND Mobile App" class="phone-img"
                 onerror="this.style.display='none'; this.parentElement.innerHTML+='<div style=\'color:#0B7A2E;font-weight:700;padding:40px;text-align:center;\'>Phone image not found</div>';">
            
            <div class="float-badge badge-1">
                <i class="fa-solid fa-check"></i>
                <span>Secure Login</span>
            </div>
            <div class="float-badge badge-2">
                <i class="fa-solid fa-arrow-trend-up"></i>
                <span>Instant Transfer</span>
            </div>
            <div class="float-badge badge-3">
                <i class="fa-solid fa-lock"></i>
                <span>256-bit SSL</span>
            </div>
        </div>
        
        <!-- Right: Text + manage_your_money.mp4 -->
        <div class="app-text-side">
            <h3>Manage Your Money,<br><span>Anywhere, Anytime</span></h3>
            <p>Our mobile banking experience puts your entire financial life in your pocket. Deposit, withdraw, invest, and track every transaction — all from one beautifully designed app.</p>
            
            <div class="app-features-list">
                <div><i class="fa-solid fa-circle-check"></i> Real-time balance</div>
                <div><i class="fa-solid fa-circle-check"></i> Instant transfers</div>
                <div><i class="fa-solid fa-circle-check"></i> Smart investments</div>
                <div><i class="fa-solid fa-circle-check"></i> Loan applications</div>
                <div><i class="fa-solid fa-circle-check"></i> Bill payments</div>
                <div><i class="fa-solid fa-circle-check"></i> 24/7 support</div>
            </div>
            
            <div class="money-video-card">
                <div class="video-label">
                    <i class="fa-solid fa-circle-play"></i> HOW IT WORKS
                </div>
                <video controls playsinline preload="metadata">
                    <source src="manage_your_money.mp4" type="video/mp4">
                    Your browser does not support the video tag.
                </video>
            </div>
        </div>
        
    </div>
</section>

<!-- 6. VIDEO SECTION (cit_advert_video.mp4) -->
<section class="video-section">
    <div class="section-title">
        <h3>See CITFUND <span>In Action</span></h3>
        <p>Watch how we're making banking simple, secure and accessible for everyone across Ghana.</p>
    </div>
    <div class="video-wrapper">
        <video controls playsinline preload="metadata">
            <source src="cit_advert_video.mp4" type="video/mp4">
            Your browser does not support the video tag.
        </video>
    </div>
</section>

<!-- 7. STATS -->
<section class="stats">
    <div class="stat-box"><h3>15K+</h3><p>Active Customers</p></div>
    <div class="stat-box"><h3>120+</h3><p>Branches Nationwide</p></div>
    <div class="stat-box"><h3>GHS 50M+</h3><p>Transfers Processed</p></div>
    <div class="stat-box"><h3>24/7</h3><p>Online Support</p></div>
</section>

<!-- 8. SECURITY -->
<section class="security" id="security">
    <div class="security-image">
        <img src="https://images.unsplash.com/photo-1563986768609-322da13575f3?q=80&w=1200&auto=format&fit=crop" alt="Cyber Security">
    </div>
    <div class="security-text">
        <h3>State-of-the-Art <span>Cyber Security</span></h3>
        <p>Your financial data is protected with AES-256 encryption—the same standard used by global banks. Every transaction is monitored 24/7 to prevent fraud.</p>
        <div class="security-icons">
            <div class="sec-icon"><i class="fa-solid fa-lock"></i></div>
            <div class="sec-icon"><i class="fa-solid fa-shield-halved"></i></div>
            <div class="sec-icon"><i class="fa-solid fa-bolt"></i></div>
        </div>
    </div>
</section>

<!-- 9. CTA -->
<section class="cta" id="contact">
    <h3>Ready to Start <span>Your Journey?</span></h3>
    <p>Open your account in minutes and start banking smarter today.</p>
    <a href="selfaccountopen.html" class="btn-gold">
        Get Started Now <i class="fa-solid fa-arrow-right"></i>
    </a>
</section>

<!-- 10. FOOTER -->
<footer class="footer">
    <div class="footer-grid">
        <div>
            <h4>About CITFUND</h4>
            <a href="#">Careers</a>
            <a href="#">Press</a>
            <a href="#">News</a>
        </div>
        <div>
            <h4>Banking</h4>
            <a href="#">Savings</a>
            <a href="#">Loans</a>
            <a href="#">Investments</a>
        </div>
        <div>
            <h4>Support</h4>
            <a href="#">Help Center</a>
            <a href="#">Contact Us</a>
            <a href="#">Terms &amp; Conditions</a>
        </div>
        <div>
            <h4>Contact</h4>
            <a href="tel:0205720154"><i class="fa-solid fa-phone"></i> 020 572 0154</a>
            <a href="mailto:support@citfund.com"><i class="fa-solid fa-envelope"></i> support@citfund.com</a>
            <a href="#"><i class="fa-solid fa-location-dot"></i> Gomoa Manso, Central Region</a>
        </div>
    </div>
    <div class="copyright">
        © 2026 <span>CITFUND ENTERPRISE</span>. All Rights Reserved. | Together We Grow.
    </div>
</footer>

<script>
    // Mobile menu toggle
    document.querySelector('.menu-toggle').addEventListener('click', () => {
        const nav = document.querySelector('.nav-links');
        const isOpen = nav.style.display === 'flex';
        if (isOpen) {
            nav.style.display = 'none';
        } else {
            nav.style.display = 'flex';
            nav.style.flexDirection = 'column';
            nav.style.position = 'absolute';
            nav.style.top = '75px';
            nav.style.left = '0';
            nav.style.width = '100%';
            nav.style.background = 'white';
            nav.style.padding = '20px';
            nav.style.gap = '18px';
            nav.style.boxShadow = '0 15px 30px rgba(11,122,46,0.15)';
            nav.style.borderBottom = '3px solid #FFC72C';
        }
    });

    // Smooth scroll for internal links
    document.querySelectorAll('a[href^="#"]').forEach(a => {
        a.addEventListener('click', function(e) {
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                e.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                const nav = document.querySelector('.nav-links');
                if (window.innerWidth <= 900) nav.style.display = 'none';
            }
        });
    });

    // Pause hero video when not in viewport (perf boost on mobile)
    document.addEventListener('DOMContentLoaded', () => {
        const heroVideo = document.querySelector('.hero-video');
        if (!heroVideo) return;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) { heroVideo.play().catch(()=>{}); }
                else { heroVideo.pause(); }
            });
        }, { threshold: 0.1 });
        observer.observe(heroVideo);
    });
</script>

<!-- ===== SERVER STATUS SPLASH ===== -->
<script>
    (function(){
        var o = document.createElement('div');
        o.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(160deg,#075C22 0%,#0B7A2E 100%);z-index:999999;display:flex;flex-direction:column;justify-content:center;align-items:center;color:white;font-family:Poppins,Arial,sans-serif;transition:opacity .5s;';
        o.innerHTML = ''
            + '<div style="text-align:center;padding:20px;">'
            + '  <div id="statusIcon" style="font-size:64px;color:#FFC72C;margin-bottom:20px;animation:spin 2s linear infinite;">'
            + '    <i class="fa-solid fa-server"></i>'
            + '  </div>'
            + '  <div id="statusText" style="font-size:20px;font-weight:700;letter-spacing:0.5px;">Checking Server...</div>'
            + '  <div style="font-size:13px;letter-spacing:3px;color:rgba(255,255,255,0.6);text-transform:uppercase;margin-top:15px;">CITFUND ENTERPRISE</div>'
            + '</div>';
        document.body.appendChild(o);

        var style = document.createElement('style');
        style.innerHTML = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);

        setTimeout(function(){
            var icon = document.getElementById('statusIcon');
            var text = document.getElementById('statusText');
            icon.style.animation = 'none';
            icon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
            text.innerText = 'Server Online! Access Granted!';
            text.style.color = '#FFD75E';
            setTimeout(function(){
                o.style.opacity = '0';
                setTimeout(function(){ if (o.parentNode) o.parentNode.removeChild(o); }, 500);
            }, 1500);
        }, 1000);
    })();
</script>

</body>
</html>