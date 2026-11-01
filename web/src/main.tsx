import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider } from './auth.tsx';
import { HomeRedirect, NotFound, RequireAuth } from './layout.tsx';
import { AuditPage, PlatformPage, ProfilePage, SupportApprovalPage } from './pages/admin.tsx';
import { ActivatePage, LoginPage, ResetPasswordPage } from './pages/auth.tsx';
import { CompensationPage } from './pages/compensation.tsx';
import { DashboardPage } from './pages/dashboard.tsx';
import { FinancePage, ReceiptPage } from './pages/finance.tsx';
import { NoteEditorPage } from './pages/notes.tsx';
import { PortalPage } from './pages/portal.tsx';
import { PatientDetailPage, PatientsPage } from './pages/patients.tsx';
import { PrivacyPage } from './pages/privacy.tsx';
import { RemindersPage } from './pages/reminders.tsx';
import { ReportsPage } from './pages/reports.tsx';
import { SchedulePage } from './pages/schedule.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { StaffPage } from './pages/staff.tsx';
import { ToastProvider } from './ui.tsx';

const router = createBrowserRouter([
  { path: '/masuk', element: <LoginPage /> },
  { path: '/aktivasi', element: <ActivatePage /> },
  { path: '/reset-sandi', element: <ResetPasswordPage /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'dasbor', element: <DashboardPage /> },
      { path: 'orang-tua', element: <PortalPage /> },
      { path: 'jadwal', element: <SchedulePage /> },
      { path: 'pasien', element: <PatientsPage /> },
      { path: 'pasien/:id', element: <PatientDetailPage /> },
      { path: 'catatan/baru', element: <NoteEditorPage /> },
      { path: 'catatan/:id', element: <NoteEditorPage /> },
      { path: 'keuangan', element: <FinancePage /> },
      { path: 'kuitansi/:id', element: <ReceiptPage /> },
      { path: 'honor', element: <CompensationPage /> },
      { path: 'laporan', element: <ReportsPage /> },
      { path: 'staf', element: <StaffPage /> },
      { path: 'pengaturan', element: <SettingsPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'pengingat', element: <RemindersPage /> },
      { path: 'privasi', element: <PrivacyPage /> },
      { path: 'dukungan', element: <SupportApprovalPage /> },
      { path: 'platform', element: <PlatformPage /> },
      { path: 'profil', element: <ProfilePage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);
