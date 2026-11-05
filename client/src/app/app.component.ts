import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService, Appointment, CareNotification, Doctor, Patient, Slot, Stats, TOKEN_KEY, User } from './api.service';

import { LiveUpdatesService } from './live-updates.service';

@Component({ selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule], templateUrl: './app.component.html' })
export class AppComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  live = inject(LiveUpdatesService);
  patients = signal<Patient[]>([]);
  notifications = signal<CareNotification[]>([]);
  cancellationTarget = signal<Appointment | null>(null);
  cancellationNotice = signal<CareNotification | null>(null);
  cancellationError = signal('');
  notificationError = signal('');
  notificationBusy = signal(false);
  cancellationReason = '';
  patientSearch = '';
  private sessionEpoch = 0;
  private refreshRequestId = 0;
  private liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private cancellationPromptEligible = false;
  private promptedNotifications = new Set<number>();

  get unreadCount() { return this.notifications().filter(n => !n.read_at).length; }
  get cancellationReasonValid() { const length=this.cancellationReason.trim().length; return length>=5 && length<=500; }
  get filteredPatients() { const q=this.patientSearch.trim().toLowerCase(); return this.patients().filter(p => !q || (p.name+' '+p.email+' '+(p.phone || '')).toLowerCase().includes(q)); }
  get modalOpen() { return !!this.selectedDoctor() || this.doctorEditor() || !!this.cancellationTarget() || !!this.cancellationNotice(); }
  emailStatusLabel(status: string | null | undefined) { return ({not_configured:'Not configured',pending:'Pending',sent:'Sent — SMTP accepted',failed:'Failed'} as Record<string,string>)[status || 'not_configured'] || 'Unknown'; }
  connectLive() {
    if(!this.user() || !localStorage.getItem(TOKEN_KEY))return;
    this.live.connect(() => { this.cancellationPromptEligible=true; this.scheduleLiveRefresh(); }, () => { this.cancellationPromptEligible=true; this.scheduleLiveRefresh(); });
  }
  scheduleLiveRefresh() {
    if(this.liveRefreshTimer) clearTimeout(this.liveRefreshTimer);
    this.liveRefreshTimer=setTimeout(async () => {
      this.liveRefreshTimer=null;
      if(!this.user()) return;
      await this.refresh(true);
      if(this.selectedDoctor()) await this.loadSlots(true);
    }, 16);
  }
  ngOnDestroy() { this.sessionEpoch++;this.refreshRequestId++;this.slotRequestId++;this.live.disconnect(); if(this.liveRefreshTimer) clearTimeout(this.liveRefreshTimer); }
  tryShowCancellationNotice() {
    if(!this.ready() || !this.user() || this.isAdmin || !this.cancellationPromptEligible || this.modalOpen || this.busy() || this.notificationBusy()) return;
    this.cancellationPromptEligible=false;
    const latest=this.notifications().filter(n => !n.read_at && n.title==='Appointment cancelled by clinic' && !this.promptedNotifications.has(n.id)).sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime() || b.id-a.id)[0];
    if(latest) { this.promptedNotifications.add(latest.id); this.notificationError.set(''); this.cancellationNotice.set(latest); this.focusDialog(); }
  }
  async markNotificationRead(n:CareNotification) {
    if(this.notificationBusy()) return;
    this.notificationBusy.set(true); this.notificationError.set(''); const epoch=this.sessionEpoch;
    try {
      const data=await firstValueFrom(this.api.patch<{notification:CareNotification}>('/notifications/'+n.id+'/read'));
      if(epoch!==this.sessionEpoch) return;
      this.refreshRequestId++;this.notifications.update(items=>items.map(item=>item.id===n.id ? data.notification : item));
      if(this.cancellationNotice()?.id===n.id) { this.cancellationNotice.set(null); this.restoreFocus(); }
      await this.refresh(true);
    } catch(e) { if(epoch===this.sessionEpoch)this.notificationError.set(this.errorText(e)); }
    finally { if(epoch===this.sessionEpoch)this.notificationBusy.set(false); }
  }
  async dismissCancellationNotice() { const notice=this.cancellationNotice(); if(notice) await this.markNotificationRead(notice); }
  closeCancellationNotice() { if(this.notificationBusy())return;this.cancellationNotice.set(null);this.notificationError.set('');this.restoreFocus(); }
  notificationEmailStatus(n:CareNotification) { return n.email_status || n.mail_status || 'not_configured'; }
  async markAllNotificationsRead() {
    if(this.notificationBusy() || !this.unreadCount) return;
    this.notificationBusy.set(true); this.notificationError.set(''); const epoch=this.sessionEpoch;
    try { await firstValueFrom(this.api.patch('/notifications/read-all')); if(epoch===this.sessionEpoch) { const now=new Date().toISOString();this.notifications.update(items=>items.map(n=>({...n,read_at:n.read_at || now})));await this.refresh(true); } }
    catch(e) { if(epoch===this.sessionEpoch)this.notificationError.set(this.errorText(e)); }
    finally { if(epoch===this.sessionEpoch)this.notificationBusy.set(false); }
  }
  openAdminCancellation(a:Appointment) { if(this.busy() || !this.isAdmin)return;this.cancellationReason='';this.cancellationError.set('');this.cancellationTarget.set(a);this.focusDialog(); }
  closeAdminCancellation() { if(this.busy())return;this.cancellationTarget.set(null);this.cancellationError.set('');this.restoreFocus();this.tryShowCancellationNotice(); }
  async confirmAdminCancellation() {
    const target=this.cancellationTarget();
    if(!target || this.busy())return;
    if(!this.cancellationReasonValid) {this.cancellationError.set('Please enter a reason between 5 and 500 characters, excluding surrounding spaces.');return;}
    this.busy.set(true);this.cancellationError.set('');this.clearMessages();
    try {
      await firstValueFrom(this.api.patch('/admin/appointments/'+target.id+'/status',{status:'cancelled',reason:this.cancellationReason.trim()}));
      this.cancellationTarget.set(null);this.restoreFocus();this.success.set('Appointment cancelled. The patient can read the reason in their notifications. Email delivery depends on server configuration.');await this.refresh();
    } catch(e) {this.cancellationError.set(this.errorText(e));}
    finally {this.busy.set(false);this.tryShowCancellationNotice();}
  }
  user = signal<User | null>(null); ready = signal(false); busy = signal(false); loading = signal(false);
  error = signal(''); success = signal(''); page = signal('dashboard'); authMode = signal('login');
  doctors = signal<Doctor[]>([]); appointments = signal<Appointment[]>([]); specializations = signal<string[]>([]);
  stats = signal<Stats>({ doctors: 0, patients: 0, upcoming: 0, completed: 0 });
  selectedDoctor = signal<Doctor | null>(null); slots = signal<Slot[]>([]); slotsLoading = signal(false); selectedSlot = signal<Slot | null>(null);
  doctorEditor = signal(false); editingDoctorId: number | null = null;
  name = ''; email = ''; password = ''; phone = ''; search = ''; specialization = ''; historyFilter = 'all'; reason = '';
  bookingDate = this.localDate(); minDate = this.localDate(); slotDate = this.localDate(); slotDoctorId = ''; slotStart = '09:00'; slotEnd = '17:00'; slotInterval = 30;
  doctorForm = this.emptyDoctor();
  today = new Date();
  private slotRequestId = 0;
  private priorFocus: HTMLElement | null = null;
  focusDialog() { this.priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; requestAnimationFrame(() => document.querySelector<HTMLElement>('.modal-panel button:not([disabled])')?.focus()); }
  restoreFocus() { const target=this.priorFocus;requestAnimationFrame(() => {if(target?.isConnected)target.focus();else document.querySelector<HTMLElement>('#main-content')?.focus();}); }
  closeDoctorEditor() { if (!this.busy()) { this.doctorEditor.set(false); this.restoreFocus(); requestAnimationFrame(()=>this.tryShowCancellationNotice()); } }
  dialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); if (this.selectedDoctor()) this.closeBooking(); else if(this.doctorEditor()) this.closeDoctorEditor(); else if(this.cancellationTarget()) this.closeAdminCancellation(); else if(this.cancellationNotice()) this.closeCancellationNotice(); return; }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(el => el.getClientRects().length > 0);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }
  get isAdmin() { return this.user()?.role === 'admin'; }
  get filteredDoctors() { const text = this.search.trim().toLowerCase(); return this.doctors().filter(d => (this.isAdmin || !!d.active) && (!this.specialization || d.specialization === this.specialization) && (!text || (d.name + ' ' + d.specialization + ' ' + d.qualification).toLowerCase().includes(text))); }
  get upcoming() { return this.appointments().filter(a => this.isUpcoming(a)).sort((a,b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()); }
  get nextAppointment() { return this.upcoming[0]; }
  get filteredAppointments() { return this.appointments().filter(a => this.historyFilter === 'all' || (this.historyFilter === 'upcoming' ? this.isUpcoming(a) : a.status === this.historyFilter)).sort((a,b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()); }
  get completedCount() { return this.appointments().filter(a => a.status === 'completed').length; }
  get firstName() { return this.user()?.name.split(' ')[0] || 'there'; }
  get pageTitle() { return ({dashboard:'Your health, at a glance',doctors:'Find your care team',appointments:'Your appointments',profile:'Your personal space',manage:'Doctor management',slots:'Availability planner',patients:'People in your care',notifications:'Your care updates'} as Record<string,string>)[this.page()] || 'Careflow'; }
  localDate(date = new Date()) { return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0'); }
  initials(name: string) { return name.replace(/^Dr\.?\s*/i, '').split(' ').filter(Boolean).slice(0,2).map(s => s[0]).join('').toUpperCase(); }
  isUpcoming(a: Appointment) { return !['cancelled','completed'].includes(a.status) && new Date(a.start_time).getTime() > Date.now(); }
  canComplete(a: Appointment) { return a.status === 'booked' && new Date(a.end_time).getTime() <= Date.now(); }
  canAdminCancel(a: Appointment) { return a.status === 'booked'; }
  emptyDoctor() { return {name:'',specialization:'',qualification:'',bio:'',experience:0,fee:0}; }
  clearMessages() { this.error.set(''); this.success.set(''); }
  errorText(e: unknown) { return e instanceof HttpErrorResponse ? (e.error?.error || (e.status===0 ? 'We cannot reach the server. Please check that it is running and try again.' : 'Something went wrong. Please try again.')) : 'Something went wrong. Please try again.'; }
  fail(e:unknown) {this.error.set(this.errorText(e));}
  async ngOnInit() {
    if(localStorage.getItem(TOKEN_KEY)) {
      try { const data=await firstValueFrom(this.api.get<{user:User}>('/auth/me')); this.sessionEpoch++;this.user.set(data.user);this.cancellationPromptEligible=true;await this.refresh();this.connectLive(); }
      catch(e) {localStorage.removeItem(TOKEN_KEY);this.live.disconnect();this.fail(e);}
    }
    this.ready.set(true);this.tryShowCancellationNotice();
  }
  async authenticate() {
    if(this.busy())return;this.clearMessages();this.busy.set(true);
    try {
      const body=this.authMode()==='login' ? {email:this.email,password:this.password} : {name:this.name,email:this.email,password:this.password,phone:this.phone};
      const data=await firstValueFrom(this.api.post<{token:string;user:User}>('/auth/'+this.authMode(),body));
      this.sessionEpoch++;localStorage.setItem(TOKEN_KEY,data.token);this.user.set(data.user);this.password='';this.cancellationPromptEligible=true;this.promptedNotifications.clear();await this.refresh();this.connectLive();
    } catch(e) {this.fail(e);}finally {this.busy.set(false);this.tryShowCancellationNotice();}
  }
  demo(role: 'patient'|'admin') { this.authMode.set('login'); this.email=role+'@careflow.demo'; this.password=role === 'patient' ? 'Patient123!' : 'Admin123!'; }
  logout() {
    this.sessionEpoch++;this.refreshRequestId++;this.slotRequestId++;
    this.live.disconnect();if(this.liveRefreshTimer)clearTimeout(this.liveRefreshTimer);this.liveRefreshTimer=null;
    localStorage.removeItem(TOKEN_KEY);this.user.set(null);this.doctors.set([]);this.appointments.set([]);this.patients.set([]);this.notifications.set([]);this.selectedDoctor.set(null);this.doctorEditor.set(false);this.cancellationTarget.set(null);this.cancellationNotice.set(null);this.cancellationPromptEligible=false;this.promptedNotifications.clear();this.notificationBusy.set(false);this.notificationError.set('');this.patientSearch='';this.page.set('dashboard');this.loading.set(false);this.clearMessages();
  }
  navigate(page:string) {this.page.set(page);this.clearMessages();}
  async refresh(quiet=false) {
    if(!this.user())return;
    const epoch=this.sessionEpoch, requestId=++this.refreshRequestId, admin=this.isAdmin;
    if(!quiet)this.loading.set(true);
    try {
      const [d,a,s,n,patients,stats]=await Promise.all([
        firstValueFrom(this.api.get<{doctors:Doctor[]}>('/doctors',admin ? {includeInactive:'true'} : {})),
        firstValueFrom(this.api.get<{appointments:Appointment[]}>(admin ? '/admin/appointments' : '/appointments')),
        firstValueFrom(this.api.get<{specializations:string[]}>('/specializations')),
        firstValueFrom(this.api.get<{notifications:CareNotification[]}>('/notifications')),
        admin ? firstValueFrom(this.api.get<{patients:Patient[]}>('/admin/patients')) : Promise.resolve(null),
        admin ? firstValueFrom(this.api.get<{stats:Stats}>('/admin/stats')) : Promise.resolve(null)
      ]);
      if(epoch!==this.sessionEpoch || requestId!==this.refreshRequestId)return;
      this.doctors.set(d.doctors);this.appointments.set(a.appointments);this.specializations.set(s.specializations);this.notifications.set(n.notifications.slice().sort((x,y)=>new Date(y.created_at).getTime()-new Date(x.created_at).getTime() || y.id-x.id));
      if(patients)this.patients.set(patients.patients);if(stats)this.stats.set(stats.stats);
    } catch(e) {if(epoch===this.sessionEpoch && requestId===this.refreshRequestId)this.fail(e);}
    finally {if(epoch===this.sessionEpoch && requestId===this.refreshRequestId){this.loading.set(false);this.tryShowCancellationNotice();}}
  }
  async openBooking(doctor: Doctor) { this.clearMessages(); const next=new Date();next.setDate(next.getDate()+1);if(next.getDay()===0)next.setDate(next.getDate()+1);this.bookingDate=this.localDate(next);this.reason='';this.selectedDoctor.set(doctor);this.focusDialog();await this.loadSlots(); }
  closeBooking() { if(!this.busy()) { this.selectedDoctor.set(null); this.slotRequestId++; this.restoreFocus(); requestAnimationFrame(()=>this.tryShowCancellationNotice()); } }
  async loadSlots(preserveSelection=false) { const doctor=this.selectedDoctor(); if(!doctor)return;const requestId=++this.slotRequestId;this.slotsLoading.set(true);if(!preserveSelection){this.selectedSlot.set(null);this.slots.set([]);}const requestedDate=this.bookingDate;if(!requestedDate || requestedDate<this.minDate){this.slotsLoading.set(false);return;}try {const data=await firstValueFrom(this.api.get<{slots:Slot[]}>('/doctors/'+doctor.id+'/slots',{date:requestedDate}));if(requestId===this.slotRequestId && this.selectedDoctor()?.id===doctor.id){this.slots.set(data.slots);if(preserveSelection){const current=this.selectedSlot();if(current)this.selectedSlot.set(data.slots.find(s=>s.id===current.id && this.slotAvailable(s)) || null);}}}catch(e){if(requestId===this.slotRequestId)this.fail(e);}finally{if(requestId===this.slotRequestId)this.slotsLoading.set(false);} }
  slotAvailable(slot: Slot) { return !!slot.available && new Date(slot.start_time).getTime()>Date.now(); }
  async book() { const slot=this.selectedSlot();if(!slot || this.busy())return;if(this.reason.trim().length>500){this.error.set('Please keep the visit reason within 500 characters.');return;}this.busy.set(true);this.clearMessages();try{await firstValueFrom(this.api.post('/appointments',{slotId:slot.id,reason:this.reason.trim()}));this.selectedDoctor.set(null);this.slotRequestId++;this.restoreFocus();this.page.set('appointments');this.historyFilter='upcoming';this.success.set('You’re booked! Your next step toward feeling your best is on the calendar.');await this.refresh();}catch(e){this.fail(e);await this.loadSlots();}finally{this.busy.set(false);requestAnimationFrame(()=>this.tryShowCancellationNotice());} }
  async cancel(a:Appointment) { if(this.busy() || !window.confirm('Cancel your appointment with '+a.doctor_name+'? This will release the time for someone else.'))return;this.busy.set(true);this.clearMessages();try{await firstValueFrom(this.api.patch('/appointments/'+a.id+'/cancel'));this.success.set('Appointment cancelled. You can book a new time whenever you’re ready.');await this.refresh();}catch(e){this.fail(e);}finally{this.busy.set(false);requestAnimationFrame(()=>this.tryShowCancellationNotice());} }
  editDoctor(d?:Doctor) {this.clearMessages();this.editingDoctorId=d?.id ?? null;this.doctorForm=d ? {name:d.name,specialization:d.specialization,qualification:d.qualification,bio:d.bio,experience:d.experience,fee:d.fee} : this.emptyDoctor();this.doctorEditor.set(true);this.focusDialog();}
  async saveDoctor() {if(this.busy())return;if(this.doctorForm.bio.length>1000 || this.doctorForm.experience<0 || this.doctorForm.experience>70){this.error.set('Keep the biography within 1,000 characters and experience between 0 and 70 years.');return;}this.busy.set(true);this.clearMessages();try{await firstValueFrom(this.editingDoctorId ? this.api.put('/admin/doctors/'+this.editingDoctorId,this.doctorForm) : this.api.post('/admin/doctors',this.doctorForm));this.doctorEditor.set(false);this.restoreFocus();this.success.set('Doctor details saved.');await this.refresh();}catch(e){this.fail(e);}finally{this.busy.set(false);requestAnimationFrame(()=>this.tryShowCancellationNotice());} }
  async deactivate(d:Doctor) {if(this.busy() || !window.confirm('Deactivate '+d.name+'? They will no longer appear for new bookings.'))return;this.busy.set(true);this.clearMessages();try{await firstValueFrom(this.api.delete('/admin/doctors/'+d.id));this.success.set('Doctor deactivated. Existing appointments remain in the records.');await this.refresh();}catch(e){this.fail(e);}finally{this.busy.set(false);requestAnimationFrame(()=>this.tryShowCancellationNotice());} }
  async createSlots() {if(this.busy())return;if(this.slotStart>=this.slotEnd){this.error.set('End time must be later than start time.');return;}this.busy.set(true);this.clearMessages();try{const data=await firstValueFrom(this.api.post<{created:number}>('/admin/slots',{doctorId:Number(this.slotDoctorId),date:this.slotDate,startTime:this.slotStart,endTime:this.slotEnd,intervalMinutes:Number(this.slotInterval)}));this.success.set(data.created+' appointment slots created. Patients can now book these times.');await this.refresh();}catch(e){this.fail(e);}finally{this.busy.set(false);requestAnimationFrame(()=>this.tryShowCancellationNotice());} }
  async setStatus(a:Appointment,status:'completed'|'cancelled') {
    if(status==='cancelled'){this.openAdminCancellation(a);return;}
    if(this.busy() || !this.canComplete(a) || !window.confirm('Mark this appointment as completed?'))return;
    this.busy.set(true);this.clearMessages();try{await firstValueFrom(this.api.patch('/admin/appointments/'+a.id+'/status',{status:'completed'}));this.success.set('Appointment marked completed.');await this.refresh();}catch(e){this.fail(e);}finally{this.busy.set(false);this.tryShowCancellationNotice();}
  }
}
